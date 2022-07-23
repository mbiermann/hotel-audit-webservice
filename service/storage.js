const cache = require('../client/cache')
const crypto = require('crypto')
const db = require('../client/database')
const cloudStorage = require('../client/cloud-storage')
const flatten = require('flat')
const logger = require('../utils/logger')
const safeStringify = require('json-stable-stringify')
const SHA256 = require("crypto-js/sha256")
const {GreenStayAuditRecord} = require('../model/green')

const classes = ['A','B','C','D']

let select = (fields, obj) => {
    return fields.reduce((o,k) => {o[k] = obj[k]; return o;}, {})
}

const mandatoryChecks = {
    '1': ["1","2","4","5","6","8","10","11","12","14","15","18","19","27","28","39","40","41","42"]
}
const mandatoryChecksByService = {
    '1': {
        "breakfast": ["35","36","37"],
        "restaurant": ["32","33","34","35","36","37"],
        "mice": ["44","46"],
        "spa": ["26"],
        "fitness": ["25","26"]
    }
}

exports.getAuth = (client_id, client_secret_sha256) => {
    return new Promise(async (resolve, reject) => {
        let filter = `WHERE id = '${client_id}' AND secret_sha256 = '${client_secret_sha256}'`
        let res = await db.select("api_clients", filter)
        if (res.length === 0) return reject("No such client")
        let auth = res[0]
        auth.grants = auth.grants.split(",")
        resolve(auth)
    })
}

const getCachedAuditRecordsForHkeys = (hkeys) => {
    return new Promise((resolve, reject) => {
        let data = {}
        let proms = []
        for (let hkey of hkeys) {
            proms.push(new Promise((resolve1) => {
                cache.smembers(hkey, (err, keys) => {
                    let _proms = []
                    if (keys.length > 0) {
                        for (let key of keys) {
                            _proms.push(new Promise((resolve2) => {
                                cache.get(key, (err, val) => {
                                    if (!(hkey in data)) data[hkey] = []
                                    data[hkey].push(JSON.parse(val))
                                    resolve2()
                                })
                            }))
                        }
                    }
                    Promise.all(_proms).then(resolve1)
                })
            }))
        }
        Promise.all(proms).then(() => {
            resolve(data)
        })
    })   
}

const getAuditRecordsForHkeysFromDB = (hkeys) => {
    const list = hkeys.map(val => db.escape(val)).join(', ')
    let filter = `WHERE hkey IN (${list})`
    return db.select("audits", filter)
}

const getGreenTrackingForHkeysFromDB = (hkeys) => {
    const list = hkeys.map(val => db.escape(val)).join(', ')
    let filter = `WHERE hkey IN (${list})`
    return db.select("green_tracking", filter)
}

let evalAuditRecord = (i) => {
    return new Promise(async (resolve, reject) => {
        i.status = false
        i.link = i.link ? i.link : process.env.DEFAULT_PROGRAM_LINK
        i.program_name = i.program_name ? i.program_name : process.env.DEFAULT_PROGRAM_NAME
        i.type = "cleansafe_self_inspection"
        i.missed = []
        if (i.checked != null && i.version === 1) {
            const checked = i.checked.split(',')
            mandatoryChecks['1'].forEach(v => {
                if (!checked.includes(v)) {
                    i.missed.push(v)
                }
            })
            if (i.services) {
                let services = i.services.split(',')
                for (let service of services) {
                    mandatoryChecksByService['1'][service].forEach(v => {
                        if (!checked.includes(v)) {
                            i.missed.push(v)
                        }
                    })
                }
            }    
            i.status = (i.missed.length === 0)
            if (i.status && i.audit_date !== null && i.auditor_key !== null) {
                i.type = "cleansafe_expert_inspection"
            }    
        } else {
            i.missed = mandatoryChecks['1']
        }
        i.missed = i.missed.join(",")
        resolve(i)
    })
} 

exports.getInvitations = (offset, size) => {
    return new Promise((resolve, reject) => {
        db.query(`SELECT hkey, code FROM hotels ORDER BY hkey ASC LIMIT ${offset}, ${size}`, [], (fst) => {
            db.query(`SELECT COUNT(*) as 'count' FROM hotels`, [], (snd) => {
                resolve({result: fst, total: snd[0]['count']})
            })
        })
    })
}

let getGreenhouseGasFactors = (i) => {

    return new Promise((resolve, reject) => {
        let report_year = ([2019,2021].indexOf(i.report_year) > -1 ? i.report_year : 2021)
        const cache_key = `ghg_factors_${report_year}`
        cache.get(cache_key, (err, val) => { 
            if (!!val) {
                resolve(JSON.parse(val))
            } else {
                let refrigeratorFactors = db.select("refrigerator_emission_factors")
                let fuelFactors = db.select("mobilefuels_emission_factors")
                let electricityFactors = db.select(`electricity_emission_factors_${report_year}`)

                Promise.all([refrigeratorFactors, fuelFactors, electricityFactors]).then(res => {

                    let refrigerants = {}
                    res[0].forEach(e => {
                        refrigerants[e._id] = e.factor
                    });

                    let mobileFuels = {}
                    res[1].forEach(e => {
                        mobileFuels[e._id] = e.factor
                    });

                    let electricity = {}
                    res[2].forEach(e => {
                        electricity[e._id] = e.factor
                    });

                    let result = {"refrigerants": refrigerants, "mobile_fuels": mobileFuels, "electricity": electricity}
                    cache.set(cache_key, JSON.stringify(result), 'EX', process.env.REDIS_TTL)
                    resolve(result)

                })
            }
        })

    })   
}

let evalGreenBackfillRecord = async (i) => {
    i.waterClass = benchmarkWaterConsumption(i.lH2OPOC)
    i.carbonClass = await benchmarkCarbonEmission(i, i.location_id)
    i.wasteClass = (i.kgWastePOC > -1) ? benchmarkWasteProduction(i.kgWastePOC) : 'D'
    i.greenClass = calculateGreenClass(i.carbonClass, i.waterClass, i.wasteClass)
    i.status = true
    i.type = `green_stay_backfill_mode_${i.mode}`
    return new GreenStayAuditRecord(i)
}

let evalGreenClaimRecord = async (i, full_certs_and_programs = false) => {
    if (full_certs_and_programs) { // GSI1
        let programs = await getPrograms(i.hkey)
        i.programs = programs.length > 0 ? programs : null
        let certs = await getValidCertificates(i.hkey)
        i.certs = certs.length > 0 ? certs : null
    } else { // GSI2
        i.program = await getProgram(i.hkey)
        i.cert = await getLastCertificate(i.hkey)
    }
    i.kgCo2ePOC = i.kgCo2ePor
    if (i.kgCo2ePOC > 300) {
        _addAnomaly(i, ANOMALIES.CARBON_EMISSION_TOO_HIGH, "Carbon emission per occupied room", i.kgCo2ePOC)
    }
    i.carbonClass = await benchmarkCarbonEmission(i, i.location_id)
    
    if (!i.no_water_data_available) {
        i.lH2OPOC = i.lPor
        if (i.lH2OPOC < 10) {
            _addAnomaly(i, ANOMALIES.NET_WATER_CONSUMPTION_TOO_LOW, "Liters of water per occupied room", i.lH2OPOC)
        }
        i.waterClass = benchmarkWaterConsumption(i.lH2OPOC)
    } else {
        i.lH2OPOC = -1
        i.waterClass = 'D'
    }
        
    if (!i.no_waste_data_available) {
        i.kgWastePOC = i.kgWastePor
        if (i.kgWastePOC > 10) {
            _addAnomaly(i, ANOMALIES.LANDFILL_WASTE_TOO_HIGH, "Waste per occupied room", i.kgWastePOC)
        }
        i.wasteClass = benchmarkWasteProduction(i.kgWastePOC)
    // When waste data is absent, set KPI negative and grant the worst class
    } else {
        i.kgWastePOC = -1
        i.wasteClass = 'D'
    }
    i.greenClass = calculateGreenClass(i.carbonClass, i.waterClass, i.wasteClass)
    return new GreenStayAuditRecord(i)
}

const ANOMALIES = {
    AVG_ROOMSIZE_TOO_SMALL: "AVG_ROOMSIZE_TOO_SMALL",
    ELECTRICITY_FACTOR_TOO_HIGH: "ELECTRICITY_FACTOR_TOO_HIGH",
    ELECTRICITY_FACTOR_TOO_LOW: "ELECTRICITY_FACTOR_TOO_LOW",
    DISTRICT_HEATING_FACTOR_TOO_HIGH: "DISTRICT_HEATING_FACTOR_TOO_HIGH",
    DISTRICT_HEATING_TOO_LOW: "DISTRICT_HEATING_TOO_LOW",
    LANDFILL_WASTE_TOO_HIGH: "LANDFILL_WASTE_TOO_HIGH",
    PRIVATE_COND_SPACE_LARGER_OR_EQUAL_TOTAL_COND: "PRIVATE_COND_SPACE_LARGER_OR_EQUAL_TOTAL_COND",
    TOTAL_WATER_TOO_LOW: "TOTAL_WATER_TOO_LOW",
    NET_WATER_CONSUMPTION_TOO_LOW: "NET_WATER_CONSUMPTION_TOO_LOW",
    NET_WATER_CONSUMPTION_TOO_HIGH: "NET_WATER_CONSUMPTION_TOO_HIGH",
    CARBON_EMISSION_TOO_HIGH: "CARBON_EMISSION_TOO_HIGH",
    LAUNDRY_PER_OCCUPIED_ROOM_TOO_HIGH: "LAUNDRY_PER_OCCUPIED_ROOM_TOO_HIGH",
    OCCUPANCY_TOO_LOW: "OCCUPANCY_TOO_LOW",
    TOTAL_CARBON_PER_OCCUPIED_ROOM_TOO_HIGH: "TOTAL_CARBON_PER_OCCUPIED_ROOM_TOO_HIGH"
}

const _addAnomaly = (item, anomalyType, metric, value) => {
    if (!item.anomalies) item.anomalies = []
    item.anomalies.push({
        type: anomalyType,
        metric: metric,
        value: value
    })
}

let evalGreenAuditRecord = (i, full_certs_and_programs = false) => {
    return new Promise((resolve, reject) => {
        getGreenhouseGasFactors(i).then(async factors => {

            let total_electricity_kwh = i.total_electricity_kwh || 0
            let total_gas_kwh = i.total_gas_kwh || 0
            let total_oil_litres = i.total_oil_litres || 0

            let minOccupancy = i.total_guest_rooms * 365 * 0.2
            if (minOccupancy > i.total_occupied_rooms) {
                _addAnomaly(i, ANOMALIES.OCCUPANCY_TOO_LOW, `Total occupied rooms below representative minimum of 20% of available rooms in year's time`, i.total_occupied_rooms)
            }  

            let shareRoomsToMeetingSpaces = i.total_guest_room_corridor_area_sqm / (i.total_guest_room_corridor_area_sqm + i.total_meeting_space_sqm)

            if (i.total_guest_room_corridor_area_sqm/i.total_guest_rooms < 10) {
                _addAnomaly(i, ANOMALIES.AVG_ROOMSIZE_TOO_SMALL, "Total guest room and corridor area (sqm) / Total guest rooms", i.total_guest_room_corridor_area_sqm/i.total_guest_rooms)
            }

            // Evaluate water consumption
            let consumedWater = 0
            if (!i.no_water_data_available) {
                consumedWater = i.total_metered_water + i.total_unmetered_water - i.total_sidebar_water - i.onsite_waste_water_treatment
                if ((i.total_metered_water + i.total_unmetered_water) <= 0) {
                    _addAnomaly(i, ANOMALIES.TOTAL_WATER_TOO_LOW, "Total metered and unmetered water (liters)", (i.total_metered_water + i.total_unmetered_water))
                }
            }

            let totalWaste = 0
            if (!i.no_waste_data_available) {
                totalWaste = i.landfill_waste_cm
            }

            if (i.is_privatespace_available) {
                let privateSpaceShare = (i.total_conditioned_area_sqm > 0) ? i.total_privatespace_sqm / i.total_conditioned_area_sqm : 0
                if (privateSpaceShare >= 1) {
                    _addAnomaly(i, ANOMALIES.PRIVATE_COND_SPACE_LARGER_OR_EQUAL_TOTAL_COND, "Total private conditioned space (sqm) / Total conditioned area (sqm)", privateSpaceShare)
                }
                if (i.privatespace_total_electricity_kwh > 0 || i.privatespace_total_oil_litres > 0 || i.privatespace_total_gas_kwh > 0) {
                    total_electricity_kwh -= i.privatespace_total_electricity_kwh
                    total_oil_litres -= i.privatespace_total_oil_litres
                    total_gas_kwh -= i.privatespace_total_gas_kwh
                    if (!i.no_water_data_available) consumedWater -= i.privatespace_total_water
                } else if (i.total_privatespace_sqm > 0) {
                    total_electricity_kwh -= total_electricity_kwh * privateSpaceShare
                    total_oil_litres -= total_oil_litres * privateSpaceShare
                    total_gas_kwh -= total_gas_kwh * privateSpaceShare
                    if (!i.no_water_data_available) consumedWater -= consumedWater * privateSpaceShare
                }
                if (!i.no_waste_data_available) totalWaste -= totalWaste * privateSpaceShare // Approximate, as we don't request specific figures
            }

            if (i.is_laundry_outsourced) {
                if (i.laundry_total_electricity_kwh > 0 || i.laundry_total_oil_litres > 0 || i.laundry_total_gas_kwh > 0) {
                    total_electricity_kwh += i.laundry_total_electricity_kwh
                    total_oil_litres += i.laundry_total_oil_litres
                    total_gas_kwh += i.laundry_total_gas_kwh
                    if (!i.no_water_data_available) consumedWater += i.laundry_total_water
                } else if (i.laundry_metric_tons > 0) {
                    let laundryKgPOC = Math.round((i.laundry_metric_tons*1000) / i.total_occupied_rooms,0)
                    if (laundryKgPOC > 10) {
                        _addAnomaly(i, ANOMALIES.LAUNDRY_PER_OCCUPIED_ROOM_TOO_HIGH, `Total laundry tonnage of ${i.laundry_metric_tons} divided by total occupied rooms (kilogram) of ${laundryKgPOC} too high`, i.laundry_metric_tons)
                    }                   
                    total_electricity_kwh += 180 * i.laundry_metric_tons
                    total_oil_litres += 111 * i.laundry_metric_tons
                    total_gas_kwh += 1560 * i.laundry_metric_tons
                    if (!i.no_water_data_available) consumedWater += 20000 * i.laundry_metric_tons // HWMI
                }
            }

            if (i.no_water_data_available) {
                i.lH2OPOC = -1
                i.waterClass = 'D'
            } else {
                i.lH2OPOC = (shareRoomsToMeetingSpaces * consumedWater) / i.total_occupied_rooms
                if (i.lH2OPOC < 10) {
                    _addAnomaly(i, ANOMALIES.NET_WATER_CONSUMPTION_TOO_LOW, "Liters of water per occupied room", i.lH2OPOC)
                }
                if (i.lH2OPOC > 4000) {
                    _addAnomaly(i, ANOMALIES.NET_WATER_CONSUMPTION_TOO_HIGH, "Liters of water per occupied room", i.lH2OPOC)
                }
                i.waterClass = benchmarkWaterConsumption(i.lH2OPOC)
            }
            
            let totalKgCo2e = 0

            if (i.mobile_fuels) {
                for (const [key, value] of Object.entries(JSON.parse(i.mobile_fuels)))
                    totalKgCo2e += factors.mobile_fuels[key] * value
            }

            if (i.refrigerants) {
                for (const [key, value] of Object.entries(JSON.parse(i.refrigerants)))
                    totalKgCo2e += factors.refrigerants[key] * value
            }

            if (i.total_district_heating > 0 && i.district_heating_factor) {
                totalKgCo2e += (i.total_district_heating * (i.district_heating_factor/1000))
                if (i.district_heating_factor > 3000) {
                    _addAnomaly(i, ANOMALIES.DISTRICT_HEATING_FACTOR_TOO_HIGH, "District heating emission factor (g/kWh)", i.district_heating_factor)
                } else if (i.district_heating_factor < 0) {
                    _addAnomaly(i, ANOMALIES.DISTRICT_HEATING_TOO_LOW, "District heating factor (g/kWh)", i.district_heating_factor)
                }
            }
            
            // When waste data is absent, set KPI negative and grant the worst class
            if (i.no_waste_data_available) {
                i.kgWastePOC = -1
                i.wasteClass = 'D'
            } else {
                // Evaluate waste consumption (1cm contains approx. 125kg of landfill waste: https://www.wien.gv.at/umweltschutz/abfall/pdf/umrechnungsfaktoren.pdf)
                i.kgWastePOC = (shareRoomsToMeetingSpaces * (125*totalWaste)) / i.total_occupied_rooms
                if (i.kgWastePOC > 10) {
                    _addAnomaly(i, ANOMALIES.LANDFILL_WASTE_TOO_HIGH, "Waste per occupied room", i.kgWastePOC)
                }
                i.wasteClass = benchmarkWasteProduction(i.kgWastePOC)
            }

            let electricityFactor = factors.electricity[i.electricity_emission_location]
            if (i.electricity_factor !== null) {
                if (i.electricity_factor > 3000) {
                    _addAnomaly(i, ANOMALIES.ELECTRICITY_FACTOR_TOO_HIGH, "Electricity emission factor (g/kWh)", i.electricity_factor)
                } else if (i.electricity_factor < 0) {
                    _addAnomaly(i, ANOMALIES.ELECTRICITY_FACTOR_TOO_LOW, "Electricity emission factor (g/kWh)", i.electricity_factor)
                }
                electricityFactor = i.electricity_factor/1000
            }

            let kgCo2eElectrictiy = total_electricity_kwh * electricityFactor
            let kgCo2eOil = total_oil_litres * factors.mobile_fuels.diesel
            let kgCo2eGas = total_gas_kwh * factors.mobile_fuels.gas
            totalKgCo2e += (kgCo2eElectrictiy + kgCo2eOil + kgCo2eGas)

            i.kgCo2ePOC = (shareRoomsToMeetingSpaces * totalKgCo2e) / i.total_occupied_rooms
            i.carbonClass = await benchmarkCarbonEmission(i, i.electricity_emission_location)

            if (i.kgCo2ePOC > 1000) {
                _addAnomaly(i, ANOMALIES.TOTAL_CARBON_PER_OCCUPIED_ROOM_TOO_HIGH, `Total carbon per occupied room unusually high above 1 ton carbon equivalent`, i.kgCo2ePOC)
            }  

            i.greenClass = calculateGreenClass(i.carbonClass, i.waterClass, i.wasteClass)

            if (full_certs_and_programs) { // GSI1
                let programs = await getPrograms(i.hkey)
                i.programs = programs.length > 0 ? programs : null
                let certs = await getValidCertificates(i.hkey)
                i.certs = certs.length > 0 ? certs : null
            } else { // GSI2
                i.program = await getProgram(i.hkey)
                i.cert = await getLastCertificate(i.hkey)
            }

            let rec = new GreenStayAuditRecord(i)
            resolve(rec)
        })
        
    })
} 

let calculateGreenClass = (carbonClass, wasteClass, waterClass) => {
    let greenClassIdx = Math.round((classes.indexOf(carbonClass)+1)*0.6+(classes.indexOf(waterClass)+1)*0.2+(classes.indexOf(wasteClass)+1)*0.2)
    return classes[greenClassIdx-1]
}

let benchmarkCarbonEmission = async (i, emissionLocation) => {
    // Index values based on CHSB2020 M1 countries only LowerQ, Mean, UpperQ
    let thresholds = [19,31,38]
    // Update default benchmark values with location-specific benchmark if exists
    const cacheKey = `carbon_benchmark:${emissionLocation}:${i.report_year}`
    let cacheProm = new Promise((resolve, reject) => {
        cache.get(cacheKey, (err, benchmark) => {
            if (err) reject(err)
            resolve(JSON.parse(benchmark))
        })
    })
    let benchmark = await cacheProm
    if (!benchmark) {
        benchmark = await db.select("green_benchmark", `WHERE location_id = '${emissionLocation}' AND reporting_year <= '${i.report_year}'`)
        cache.set(cacheKey, JSON.stringify(benchmark), 'EX', process.env.REDIS_TTL)
    }
    if (benchmark.length > 0) {
        thresholds = [benchmark[0].A, benchmark[0].B, benchmark[0].C]
    }
    let carbonClass = 'D'
    for (let j = 0; j < thresholds.length; j++) {
        if (i.kgCo2ePOC <= thresholds[j]) {
            carbonClass = classes[j]
            break
        }
    }
    return carbonClass
}

let benchmarkWaterConsumption = (lH2OPOC) => {
    let waterThresholds = [200,700,1100] // Based on Cornell HWMI Index 2021, https://www.sciencedirect.com/science/article/abs/pii/S026151771400137X?via%3Dihub, https://www.mdpi.com/2071-1050/11/23/6880/pdf
    let waterClass = 'D'
    for (let i = 0; i < waterThresholds.length; i++) {
        if (lH2OPOC <= waterThresholds[i]) {
            waterClass = classes[i]
            break
        }
    }
    return waterClass
}

let benchmarkWasteProduction = (kgWastePOC) => {
    let wasteThresholds = [0.3,0.6,1]
    let wasteClass = 'D'
    for (let i = 0; i < wasteThresholds.length; i++) {
        if (kgWastePOC <= wasteThresholds[i]) {
            wasteClass = classes[i]
            break
        }
    }
    return wasteClass
}

let evalGreenExceptionRecord = (i) => {
    return new Promise(async (resolve, reject) => {
        let program = await getProgram(i.hkey)
        let cert = await getLastCertificate(i.hkey)
        let rec = {}
        rec.hkey = i.hkey
        rec.id = i._id
        rec.created_date = i._createdDate
        rec.updated_date = i._updatedDate
        rec.opening_date = i.opening_date
        if (program) rec.program = select(['name', 'link'], program)
        if (cert) rec.cert = select(['cert_id', 'validity_start', 'validity_end', 'url', 'issuer'], cert)
        rec.type = "green_stay_not_applicable"
        // Only pass exceptions when older than begin of latest report year
        let latestReportYear = 2021
        rec.status = (i.opening_date >= new Date(latestReportYear, 0))
        resolve(rec)
    })
} 

let evalGeosureRecord = (i) => {
    return new Promise((resolve, reject) => {
        i.type = "geosure"
        i.status = true
        resolve(i)
    })
}

const getProgram = async (hkey) => {
    let res = await db.select("green_programs", `WHERE hkey = '${hkey}'`)
    return res[0]
}

const getPrograms = async (hkey) => {
    let res = await db.select("green_programs", `WHERE hkey = '${hkey}'`)
    return res
}
exports.getPrograms = getPrograms

const getLastCertificate = async (hkey) => {
    let res = await db.select('green_certificates', `WHERE hkey = ${hkey}`, '*', 'ORDER BY validity_end DESC', 0, 1)
    return res[0]
}
exports.getLastCertificate = getLastCertificate

const getValidCertificates = async (hkey) => {
    let res = await db.select('green_certificates', `WHERE hkey = ${hkey} AND validity_end >= NOW()`)
    return res
}
exports.getValidCertificates = getValidCertificates

const cacheAuditRecordForHkey = (hkey, elem) => {
    let key = crypto.createHash('md5').update(JSON.stringify(elem)).digest('hex')
    cache.set(key, JSON.stringify(elem), 'EX', process.env.REDIS_TTL);
    cache.sadd(hkey, key)
    cache.expire(hkey, process.env.REDIS_TTL)
}

const cacheGreenAuditRecord = (elem, filter) => {
    cache.set(`green:${elem.hkey}:${filter}`, JSON.stringify(elem), 'EX', process.env.REDIS_TTL);
}

const cacheGSI2AuditRecord = (customerId, rec, filter) => {
    cache.set(`gsi2:${customerId}:${rec.hkey}:${filter}`, JSON.stringify(rec), 'EX', process.env.REDIS_TTL);
}

const cacheGreenExceptionRecordForHkey = (hkey, elem) => {
    cache.set(`green_exception:${hkey}`, JSON.stringify(elem), 'EX', process.env.REDIS_TTL);
}

const cacheGreenTrackingForHkey = (hkey, elem) => {
    cache.set(`green_tracking:${hkey}`, JSON.stringify(elem), 'EX', process.env.REDIS_TTL);
}

const getCachedGSI2AuditRecordForHkeyAndCustomerId = (hkey, customerId, filter) => {
    return new Promise((resolve, reject) => {
        cache.get(`gsi2:${customerId}:${hkey}:${filter}`, (err, val) => {
            let obj = null
            if (val) obj = JSON.parse(val)
            resolve({hkey: hkey, obj: obj})
        })
    })
}

const getCachedGreenAuditRecordsForHkeys = (hkeys, filter) => {
    return new Promise((resolve, reject) => {
        let data = {}
        let proms = []
        for (let hkey of hkeys) {
            proms.push(new Promise((resolve1) => {
                cache.get(`green:${hkey}:${filter}`, (err, obj) => {
                    if (!!obj) data[hkey] = JSON.parse(obj)
                    resolve1()
                })
            }))
        }
        Promise.all(proms).then(() => {
            resolve(data)
        })
    })   
}

const getCachedGreenExceptionRecordsForHkeys = (hkeys) => {
    return new Promise((resolve, reject) => {
        let data = {}
        let proms = []
        for (let hkey of hkeys) {
            proms.push(new Promise((resolve1) => {
                cache.get(`green_exception:${hkey}`, (err, val) => {
                    if (!!val) data[hkey] = JSON.parse(val)
                    resolve1()
                })
            }))
        }
        Promise.all(proms).then(() => {
            resolve(data)
        })
    })   
}

const getCachedGreenTrackingForHkeys = (hkeys) => {
    return new Promise((resolve, reject) => {
        let data = {}
        let proms = []
        for (let hkey of hkeys) {
            proms.push(new Promise((resolve1) => {
                cache.get(`green_tracking:${hkey}`, (err, val) => {
                    if (!!val) data[hkey] = JSON.parse(val)
                    resolve1()
                })
            }))
        }
        Promise.all(proms).then(() => {
            resolve(data)
        })
    })   
}

const getAuditRecordsForHkeys = (hkeys, bypass_cache = false, bypass_redirect_mapping = false) => {
    return new Promise(async (resolve, reject) => {
        try {
            let res = {}
            hkeys = hkeys.filter((val) => !isNaN(Number(val))).map((val) => Number(val))
            if (hkeys.length === 0) return resolve([])
            if (!bypass_cache) {
                res = await getCachedAuditRecordsForHkeys(hkeys)
                for (let hkey of Object.keys(res)) {
                    hkeys.splice(hkeys.indexOf(Number(hkey)), 1)
                }
                if (hkeys.length === 0) return resolve(res)
            }
            let items = await getAuditRecordsForHkeysFromDB(hkeys)
            let proms = []
            for (let i of items) {
                proms.push(new Promise(async (rslv, rjt) => {
                    if (!res[i.hkey]) res[i.hkey] = [];
                    let elem = await evalAuditRecord(i)
                    if (!bypass_cache) cacheAuditRecordForHkey(i.hkey, elem)
                    res[i.hkey].push(elem)
                    hkeys.splice(hkeys.indexOf(Number(i.hkey)), 1)
                    rslv()
                }))
            }
            await Promise.all(proms)
            resolve(res)
        } catch (err) {
            reject(err)
        }
    })
}
exports.getAuditRecordsForHkeys = getAuditRecordsForHkeys

const getGreenTrackingForHkeys = (hkeys, bypass_cache = false) => {
    return new Promise(async (resolve, reject) => {
        try {
            let res = {}
            hkeys = hkeys.filter((val) => !isNaN(Number(val))).map((val) => Number(val))
            if (hkeys.length === 0) return resolve([])
            if (!bypass_cache) {
                res = await getCachedGreenTrackingForHkeys(hkeys)
                for (let hkey of Object.keys(res)) {
                    hkeys.splice(hkeys.indexOf(Number(hkey)), 1)
                }
                if (hkeys.length === 0) return resolve(res)
            }
            let items = await getGreenTrackingForHkeysFromDB(hkeys)
            let proms = []
            for (let i of items) {
                proms.push(new Promise(async (rslv, rjt) => {
                    if (!bypass_cache) cacheGreenTrackingForHkey(i.hkey, i)
                    res[i.hkey] = i
                    hkeys.splice(hkeys.indexOf(Number(i.hkey)), 1)
                    rslv()
                }))
            }
            await Promise.all(proms)
            resolve(res)
        } catch (err) {
            reject(err)
        }
    })
}

exports.getGreenTrackingForHkeys = getGreenTrackingForHkeys

exports.getTouchlessStatusForHkeys = (hkeys) => {
    return new Promise(async (resolve, reject) => {
        try {
            hkeys = hkeys.filter((val) => !isNaN(Number(val))).map((val) => Number(val))
            if (hkeys.length === 0) return resolve([])
    
            getCachedTouchlessStatusForHKeys(hkeys).then((res) => {
                const hkeysFromCache = Object.keys(res).map(e => Number(e))
                let touchlessHkeys = new Set(hkeysFromCache)

                let leftHkeys = hkeys.filter( el => hkeysFromCache.indexOf(Number(el)) < 0 )
                if (leftHkeys.length === 0) return resolve(Array.from(touchlessHkeys))
                let filter = `WHERE hkey IN (${leftHkeys})`
                let mpp = db.select("mpp", filter)
                let mpsmart = db.select("mpsmart", filter)
                let smarthotel = db.select("smarthotels", filter)

                return Promise.all([mpp, mpsmart, smarthotel]).then(res => {
                    res.forEach(list => {
                        list.forEach(item => {
                            touchlessHkeys.add(item.hkey)
                            cacheTouchlessStatusForHkey(item.hkey, true)
                        })
                    })
                    resolve(Array.from(touchlessHkeys))
                })
            })
        } catch (err) {
            reject(err)
        }
    })
}

exports.getAllHotelsWithGreenRecord = () => {
    return new Promise((resolve, reject) => {
        let proms = []
        proms.push(getHotelsWithGreenClaim())
        proms.push(getHotelsWithGreenAudit())
        proms.push(getHotelsWithGreenException())
        proms.push(getHotelsWithGreenProgram())
        proms.push(getHotelsWithGreenCert())
        proms.push(getHotelsWithGSI2Report())
        let hotels = []
        Promise.all(proms).then(res => {
            res.forEach(r => hotels.push(...r))
            let uniqueHotels = hotels.filter((item, pos) => {
                return hotels.findIndex(x => x.hkey === item.hkey) == pos;
            })
            resolve(uniqueHotels)
        })
    })
}

exports.getHkeysForCustomer = (ref) => {
    return new Promise((resolve, reject) => {
        if (ref != "SoC") return reject("Invalid reference")
        return db.query('SELECT h.hkey, h.name, h.chain, h.chain_id, h.city, h.country, h.hrs_office FROM hotels AS h WHERE h.hkey IN (SELECT h1.hkey FROM hotels h1 WHERE ST_WITHIN(POINT(h1.`long`, h1.`lat`), ST_GEOMFROMTEXT(\'Polygon((-124.4009 41.9983,  -123.6237 42.0024,  -123.1526 42.0126,  -122.0073 42.0075,  -121.2369 41.9962,  -119.9982 41.9983,  -120.0037 39.0021,  -117.9575 37.5555,  -116.3699 36.3594,  -114.6368 35.0075,  -114.6382 34.9659,  -114.6286 34.9107,  -114.6382 34.8758,  -114.5970 34.8454,  -114.5682 34.7890,  -114.4968 34.7269,  -114.4501 34.6648,  -114.4597 34.6581,  -114.4322 34.5869,  -114.3787 34.5235,  -114.3869 34.4601,  -114.3361 34.4500,  -114.3031 34.4375,  -114.2674 34.4024,  -114.1864 34.3559,  -114.1383 34.3049,  -114.1315 34.2561,  -114.1651 34.2595,  -114.2249 34.2044,  -114.2221 34.1914,  -114.2908 34.1720,  -114.3237 34.1368,  -114.3622 34.1186,  -114.4089 34.1118,  -114.4363 34.0856,  -114.4336 34.0276,  -114.4652 34.0117,  -114.5119 33.9582,  -114.5366 33.9308,  -114.5091 33.9058,  -114.5256 33.8613,  -114.5215 33.8248,  -114.5050 33.7597,  -114.4940 33.7083,  -114.5284 33.6832,  -114.5242 33.6363,  -114.5393 33.5895,  -114.5242 33.5528,  -114.5586 33.5311,  -114.5778 33.5070,  -114.6245 33.4418,  -114.6506 33.4142,  -114.7055 33.4039,  -114.6973 33.3546,  -114.7302 33.3041,  -114.7206 33.2858,  -114.6808 33.2754,  -114.6698 33.2582,  -114.6904 33.2467,  -114.6794 33.1720,  -114.7083 33.0904,  -114.6918 33.0858,  -114.6629 33.0328,  -114.6451 33.0501,  -114.6286 33.0305,  -114.5888 33.0282,  -114.5750 33.0351,  -114.5174 33.0328,  -114.4913 32.9718,  -114.4775 32.9764,  -114.4844 32.9372,  -114.4679 32.8427,  -114.5091 32.8161,  -114.5311 32.7850,  -114.5284 32.7573,  -114.5641 32.7503,  -114.6162 32.7353,  -114.6986 32.7480,  -114.7220 32.7191,  -115.1944 32.6868,  -117.3395 32.5121,  -117.4823 32.7838,  -117.5977 33.0501,  -117.6814 33.2341,  -118.0591 33.4578,  -118.6290 33.5403,  -118.7073 33.7928,  -119.3706 33.9582,  -120.0050 34.1925,  -120.7164 34.2561,  -120.9128 34.5360,  -120.8427 34.9749,  -121.1325 35.2131,  -121.3220 35.5255,  -121.8013 35.9691,  -122.1446 36.2808,  -122.1721 36.7268,  -122.6871 37.2227,  -122.8903 37.7783,  -123.2378 37.8965,  -123.3202 38.3449,  -123.8338 38.7423,  -123.9793 38.9946,  -124.0329 39.3088,  -124.0823 39.7642,  -124.5314 40.1663,  -124.6509 40.4658,  -124.3144 41.0110,  -124.3419 41.2386,  -124.4545 41.7170,  -124.4009 41.9983))\'))) OR h.hkey IN (SELECT h2.hkey FROM hotels h2 WHERE h2.city LIKE \'%California%\' OR city LIKE \'%Kalifornien%\');', [], (res) => {
            resolve(res)
        })
    })
}

let getGSI2AuditRecordsForHkeysAndCustomerId = (hkeys, targetCustomerId, options) => {
    const cacheFilter = SHA256(safeStringify(options))
    let shall_backfill = (options && options.backfill)
    return new Promise(async (resolve, reject) => {
        let customerId = (targetCustomerId) ? targetCustomerId : 0
        let cacheProms = []
        if (!options  || !('bypass_cache' in options) || options.bypass_cache === false) {
            for (let hkey of hkeys) {
                cacheProms.push(new Promise((resolve3) => {
                    getCachedGSI2AuditRecordForHkeyAndCustomerId(hkey, customerId, cacheFilter).then(resolve3)
                }))
            }
        }
        let cacheResults = await Promise.all(cacheProms)
        cacheResults = cacheResults.reduce((res, item, idx, arr) => {
            if (!!item.obj) res[item.hkey] = item.obj
            return res
        }, {})
        const leftHKeys = hkeys.filter(hkey => !(hkey in cacheResults))

        if (leftHKeys.length === 0) return resolve(cacheResults)

        const getHotelLeastLevelCompletedForHkey = (hkey) => {
            return new Promise((resolve, reject) => {
                db.query(`SELECT A.\`_id\` AS \`level\` FROM gsi2_levels A RIGHT JOIN gsi2_level_assessments B ON A._id = B.\`level\` WHERE B.required = 1 AND A._id = (SELECT _id FROM gsi2_levels WHERE _id NOT IN (SELECT \`level\` FROM gsi2_level_assessments WHERE required = 1 AND assessment NOT IN (SELECT C.assessment FROM gsi2_level_assessments C LEFT JOIN gsi2_reports D ON C.assessment = D.assessment WHERE C.required = 1 AND D.hkey = ${hkey})) ORDER BY \`rank\` desc limit 1) GROUP BY A._id`, 
                    async (err2, res2, flds2) => {                        
                        if (res2.length === 0) return resolve({level: "NONE"})
                        return resolve({level: res2[0].level})
                    })
            })
        }
        let _customerScoreScale = null
        let getCustomerScoreScale = async (_customerId) => {
            if (!!_customerScoreScale) return _customerScoreScale
            _customerScoreScale = await db.select("gsi2_customer_grading", `WHERE customer_id = ${_customerId}`)
            return _customerScoreScale
        }
        let proms = []

        // Fill in the footprint, program and certification data
        let footprintAudits = await getGreenAuditRecordsForHkeys(leftHKeys, {full_certs_and_programs: true, backfill: shall_backfill, bypass_cache: shall_backfill})

        leftHKeys.forEach(async hkey => {
            proms.push(new Promise(async (resolve2, reject2) => {
                const notAvailableRec = {
                    hkey: hkey,
                    status: false,
                    type: 'gsi2_not_available'
                }
                const errorRec = {
                    hkey: hkey,
                    status: false,
                    type: 'gsi2_error'
                }
                const returnError = (msg) => {
                    errorRec.msg = msg
                    cacheGSI2AuditRecord(customerId, errorRec, cacheFilter)
                    return resolve2(errorRec)
                }
                const returnNotAvailable = () => {
                    cacheGSI2AuditRecord(customerId, notAvailableRec, cacheFilter)
                    return resolve2(notAvailableRec)
                }

                try {
                    let rec = {}
                    let obj = await getHotelLeastLevelCompletedForHkey(hkey)

                    let footprintAudit = footprintAudits[hkey]
                    if (footprintAudit) {
                        const fields = ['report_year', 'kilogramCarbonPOC', 'literWaterPOC', 'kilogramWastePOC', 'carbonClass', 'waterClass', 'wasteClass', 'greenClass']
                        fields.forEach(x => {
                            if (!('footprint' in rec)) rec.footprint = {}
                            rec.footprint[x] = footprintAudit[x]
                        })
                        if (!!footprintAudit.anomalies) rec.footprint.anomalies = footprintAudit.anomalies
                        rec.footprint.status = footprintAudit.status
                        rec.footprint.type = footprintAudit.type
                        if (!!footprintAudit.original_type) rec.footprint.original_type = footprintAudit.original_type
                        rec.programs = footprintAudit.programs
                        rec.certs = footprintAudit.certs
                        rec.status = footprintAudit.status
                    }

                    let migrationMode = false
                    let outInner = {}
                    let complete = () => {
                        // Pack response
                        let out = Object.assign({hkey: hkey}, outInner, rec)
                        cacheGSI2AuditRecord(customerId, out, cacheFilter)
                        resolve2(out)    
                    }

                    let query = `SELECT B.question_id, D.category, C.weight, IF(E.response IS NULL, 0, E.response) AS response, C.customer_id
                        FROM gsi2_level_assessments A
                        LEFT JOIN gsi2_assessment_questions B ON A.assessment = B.assessment_id
                        LEFT JOIN gsi2_customer_question_weights C ON B.question_id = C.question_id
                        LEFT JOIN gsi2_questions D ON C.question_id = D._id
                        LEFT JOIN (SELECT * FROM gsi2_responses_full_view WHERE hkey = ${hkey}) E ON C.question_id = E.question_id
                        WHERE A.\`level\` = '${obj.level}' AND C.weight IS NOT NULL AND C.customer_id = (
                        SELECT MAX(customer_id) AS customer_id
                        FROM gsi2_customer_question_weights
                        WHERE customer_id IN (0,${customerId})
                        LIMIT 1)`

                    let isBackfillQuery = false
                    
                    if (obj.level === "NONE") {
                        // During migration grace period from GSI1 overwrite to Advanced level
                        if (!!rec.footprint) {
                            if (true === rec.footprint.status && "green_stay_not_applicable" != rec.footprint.type) {
                                isBackfillQuery = (shall_backfill && /backfill/.test(rec.footprint.type))
                                query = `SELECT A.customer_id, A.question_id, C.category, A.weight FROM gsi2_customer_question_weights A LEFT JOIN gsi2_assessment_questions B ON A.question_id = B.question_id LEFT JOIN gsi2_questions C ON B.question_id = C._id WHERE A.customer_id = (
                                    SELECT MAX(customer_id) AS customer_id FROM gsi2_customer_question_weights WHERE customer_id IN (0,${customerId}) LIMIT 1
                                )  AND B.assessment_id = 'HOTEL_FPR'`
                                migrationMode = true
                                obj.level = 'ADV_LEVEL'
                                obj.assessments = "'ADV_HOTEL_IND','HOTEL_FPR','HOTEL_CRT'"
                            } else { // Otherwise when no assessment/level was completed and footprint was not successful
                                rec.type = `gsi2_not_available`
                                rec.status = false
                                return complete()
                            }
                        } else {
                            return returnNotAvailable()
                        }
                    }
                    
                    db.query(query, async (error, responses, fields) => {
                        
                        if (responses.length > 0) {
                            const customerIdActual = responses[0].customer_id
                            let customerScoreScale = await getCustomerScoreScale(customerIdActual)
                            let achievePerCategory = {}
                            let points = 0
                            let maxPoints = 0
                            responses.forEach(r => {
                                if (r.weight > 0) {
                                    let map = {GSI_FPR_WATER_GRADE: 'waterClass', GSI_FPR_WASTE_GRADE: 'wasteClass', GSI_FPR_CARBON_GRADE: 'carbonClass', GSI_FPR_GREENSTAY_GRADE: 'greenClass'}
                                    let mapClass = (cls) => {return ((['D','C','B','A'].indexOf(cls) + 1)/4)}
                                    r.response = map.hasOwnProperty(r.question_id) ? mapClass(rec.footprint[map[r.question_id]]) : r.response
                                    if (!(r.category in achievePerCategory)) achievePerCategory[r.category] = {score: 0, total: 0}
                                    achievePerCategory[r.category].total += r.weight
                                    let score = parseFloat(r.response) * r.weight
                                    achievePerCategory[r.category].score += score
                                    points += score
                                    maxPoints += r.weight
                                }
                            })
                            Object.keys(achievePerCategory).map((key, index) => {
                                achievePerCategory[key] = achievePerCategory[key].score / achievePerCategory[key].total
                            })
                            
                            let grade = customerScoreScale.find(x => points >= x.min && points <= x.max)
                            grade = !!grade ? grade.grade : null

                            // Override proportionally to max score for GSI1 migration period
                            if (migrationMode) {
                                const maxScorePoints = customerScoreScale.reduce((element,max) => element.max > max ? element.max : max).max
                                let tweakPoints = points * (maxScorePoints/maxPoints)
                                grade = customerScoreScale.find(x => tweakPoints >= x.min && tweakPoints <= x.max).grade
                            }

                            outInner = {
                                customerId: customerIdActual,
                                assessment_level: obj.level,
                                scoring: {
                                    score: grade,
                                    categories: achievePerCategory,
                                    points: {
                                        is: points,
                                        max: maxPoints,
                                        percent: points/maxPoints
                                    }
                                }
                            }
                            
                            if (!grade) {
                                let msg = `Customer with ID ${customerIdActual} has grading not fully configured for ${points} points of hotel ${hkey}.`
                                console.log(msg)
                                rec.msg = msg
                                rec.type = 'gsi2_error'
                                rec.status = false
                                return complete()
                            } 

                            rec.type = `gsi2_self_inspection${isBackfillQuery && /backfill/.test(rec.footprint.type) ? '_backfill' : ''}`
                            if (grade >= customerScoreScale.find(x => x.is_cliff === 'TRUE').grade) rec.type += '_hero'
                            rec.status = true
                        } else {
                            return returnNotAvailable()
                        }

                        complete()         
                    })
                } catch (e) {
                    let msg = `Error processing GSI2 evaluation for hkey ${hkey} and customer ID ${customerId}: ${e}`
                    console.log(msg)
                    return returnError(msg)
                }
            }))        
        })
        Promise.all(proms).then(dbResults => {
            let results = dbResults.reduce((res, item, idx, arr) => {
                if (!!item) res[item.hkey] = item
                return res
            }, {})
            Object.assign(results, cacheResults)
            resolve(results)
        }).catch(reject)
    })
}
exports.getGSI2AuditRecordsForHkeysAndCustomerId = getGSI2AuditRecordsForHkeysAndCustomerId

let getGreenAuditRecordsForHkeys = (hkeys, options) => {
    let shall_backfill = (options && options.backfill)
    const cacheFilter = SHA256(safeStringify(options))
    return new Promise(async (resolve, reject) => {
        try {
            hkeys = hkeys.filter((val) => !isNaN(Number(val))).map((val) => Number(val))
            if (hkeys.length === 0) return resolve([])

            let proms = []
            const chunk = (arr, size) =>
                Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
                    arr.slice(i * size, i * size + size)
                )
            
            let jobs = chunk(hkeys, 50)

            let job = (hkeys) => {
                return new Promise(async (resolveJob, rejectJob) => {
                    let records = (options && options.bypass_cache) ? {} : (await getCachedGreenAuditRecordsForHkeys(hkeys, cacheFilter))
                    const hkeysFromCache = Object.keys(records).map(e => Number(e))
                    let leftHkeys = hkeys.filter( el => hkeysFromCache.indexOf(Number(el)) < 0 )
                    if (leftHkeys.length === 0) return resolveJob(records)
                    
                    let filter = `WHERE hkey IN (${leftHkeys})`
                    
                    let query = `SELECT C.*, E.chain_id FROM (SELECT DISTINCT(A.hkey), (SELECT MAX(B.report_year) FROM green_footprint_claims B WHERE B.hkey = A.hkey LIMIT 1) AS report_year FROM green_footprint_claims A WHERE A.hkey IN (${leftHkeys})) D LEFT JOIN green_footprint_claims C ON C.hkey = D.hkey AND C.report_year = D.report_year LEFT JOIN hotels E ON D.hkey = E.hkey`
                    await db.query(query, async (error, greenClaims, fields) => {
                        let evals = []
                        greenClaims.forEach(item => {
                            evals.push(evalGreenClaimRecord(item, !!options.full_certs_and_programs))
                            leftHkeys = leftHkeys.filter(x => x != item.hkey)    
                        })

                        let complete = async () => {
                            if (leftHkeys.length > 0) {
                                filter = `WHERE hkey IN (${leftHkeys})`
                                let greenExcs = await db.select("green_exceptions", filter)
                                greenExcs.forEach(item => {
                                    evals.push(evalGreenExceptionRecord(item))
                                    leftHkeys = leftHkeys.filter(x => x != item.hkey)
                                })
                            }
            
                            if (leftHkeys.length > 0 && shall_backfill) {
                                leftHkeys.forEach(hkey => {
                                    evals.push({hkey: hkey, type: "green_stay_not_available"})
                                })
                            }
                
                            let res = await Promise.all(evals)
                            
                            let backfillProms = []
                            res.forEach(e => {
                                if (shall_backfill && !/green_stay_self_inspection/.test(e.type)) {
                                    backfillProms.push(new Promise((resolve5, reject5) => {
                                        db.query(`SELECT * FROM green_hotels_backfill WHERE hkey = ${e.hkey}`, async (error, backfill, fields) => {
                                            if (backfill.length > 0) {
                                                let obj = await evalGreenBackfillRecord(backfill[0])
                                                obj.original_type = e.type
                                                records[e.hkey] = obj
                                            }
                                            resolve5()
                                        })
                                    }))         
                                } else {
                                    records[e.hkey] = e  
                                }              
                            })
                            await Promise.all(backfillProms) 
                            Object.values(records).forEach(e => {
                                cacheGreenAuditRecord(e, cacheFilter)  
                            })
                            resolveJob(records)
                        }

                        if (leftHkeys.length > 0) {
                            await db.query(`SELECT C.* FROM (SELECT DISTINCT(A.hkey), (SELECT MAX(B.report_year) FROM green_audits B WHERE B.hkey = A.hkey LIMIT 1) AS report_year FROM green_audits A WHERE A.hkey IN (${leftHkeys})) D LEFT JOIN green_audits C ON C.hkey = D.hkey AND C.report_year = D.report_year`, async (error2, greenAudits, fields2) => {
                                greenAudits.forEach(item => {
                                    evals.push(evalGreenAuditRecord(item, !!options.full_certs_and_programs))
                                    leftHkeys = leftHkeys.filter(x => x != item.hkey)
                                })
                                complete()
                            })
                        }
                        complete()
                    })
                })
            }

            jobs.forEach(hkeysChunk => {
                proms.push(job(hkeysChunk))
            })
            
            let finishedJobs = await Promise.all(proms)
            let records = {}
            finishedJobs.forEach(result => {
                Object.assign(records, result)
            })
            resolve(records)

        } catch (err) {
            reject(err)
        }
    })
}
exports.getGreenAuditRecordsForHkeys = getGreenAuditRecordsForHkeys

exports.getGeosureRecordsForHkeys = (hkeys, options) => {
    return new Promise(async (resolve, reject) => {
        try {
            hkeys = hkeys.filter((val) => !isNaN(Number(val))).map((val) => Number(val))
            if (hkeys.length === 0) return resolve([])
            let records = (options && options.bypass_cache) ? {} : (await getCachedGeosureRecordsForHkeys(hkeys))
            const hkeysFromCache = Object.keys(records).map(e => Number(e))
            let leftHkeys = hkeys.filter( el => hkeysFromCache.indexOf(Number(el)) < 0 )
            if (leftHkeys.length === 0) return resolve(records)
            let filter = `WHERE hkey IN (${leftHkeys})`
            let geosures = await db.select("hotels_gs_view", filter)
            let evals = geosures.map(item => evalGeosureRecord(item))
            return Promise.all(evals).then(res => {
                res.forEach(e => {
                    cacheGeosureRecordForHkey(e.hkey, e)
                    records[e.hkey] = e
                })
                resolve(records)
            })
            
        } catch (err) {
            reject(err)
        }
    })
}

exports.getGreenAuditForReportId = (id) => {
    return new Promise(async (resolve, reject) => {
        try {
            let filter = `WHERE _id = '${id}'`
            db.select("green_audits", filter).then(res => {
                if (res.length === 0) {
                    db.select("green_footprint_claims", filter).then(res => {
                        if (res.length === 0) return reject(new Error(`No green report found for ID ${id}`))
                        resolve(evalGreenClaimRecord(res[0]))
                    })
                } else {
                    resolve(evalGreenAuditRecord(res[0]))
                }
            })
        } catch (err) {
            reject(err)
        }
    })
}

const cacheTouchlessStatusForHkey = (hkey, elem) => {
    cache.set(`${hkey}:touchless`, JSON.stringify(elem), 'EX', process.env.REDIS_TTL)
}

const getCachedTouchlessStatusForHKeys = (hkeys) => {
    return new Promise((resolve) => {
        let data = {}
        let proms = []
        for (let hkey of hkeys) {
            proms.push(new Promise((resolve, reject) => {
                cache.get(`${hkey}:touchless`, (err, val) => {
                    if (val !== null) data[hkey] = JSON.parse(val)
                    resolve()
                })
            }))
        }
        Promise.all(proms).then(_ => {
            resolve(data)
        })
    })   
}

const cacheGeosureRecordForHkey = (hkey, elem) => {
    cache.set(`geosure:${hkey}`, JSON.stringify(elem), 'EX', process.env.REDIS_TTL)
}

const getCachedGeosureRecordsForHkeys = (hkeys) => {
    return new Promise((resolve) => {
        let data = {}
        let proms = hkeys.map((hkey) => new Promise((resolve, reject) => {
            cache.get(`geosure:${hkey}`, (err, val) => {
                if (val !== null) data[hkey] = JSON.parse(val)
                resolve()
            })
        }))
        Promise.all(proms).then(_ => {
            resolve(data)
        })
    })   
}

exports.getHotelStatusByHkeys = async (hkeys, programs, flat = false, bypass_cache = false, backfill = false, bypass_redirect_mapping = false, exclude = [], customerId = 0) => {
    let filter = ''
    filter = `WHERE hkey IN (${hkeys})`

    let infos = {}
    let audits = {}
    let greenTrackings = {}

    let proms = []

    let hotelRecordsFetch = db.select("hotels", filter).then(async (items) => {
        for (let i of items) {
            let elem = {
                "chain_id": i.chain_id,
                "brand_id": i.brand_id,
                "brand": i.brand,
                "chain": i.chain,
                "name": i.name,
                "city": i.city,
                "country": i.country,
                "mpp": !!i.mpp,
                "mpp_prospect": !!i.mpp_prospect,
                "ccr": !!i.ccr,
                "performance_cluster": i.performance_cluster,
                "sourcing_relevant": i.sourcing_relevant,
                "hrs_office": i.hrs_office,
                "code": i.code,
                "cs_audit_link": "https://www.hotel-audit.hrs.com/individual-assessment/"+i.hkey+"/"+i.code+"?utm_source=hrs-hs&utm_medium=email&utm_campaign=individual_invitation&utm_content="+i.hkey,
                "gs_audit_link": "https://www.hotel-audit.hrs.com/green/overview/hotel/"+i.hkey+"/"+i.code+"?utm_source=hrs-hs&utm_medium=email&utm_campaign=individual_invitation&utm_content="+i.hkey

            }
            for (let key of exclude) delete elem[key]
            infos[i.hkey] = elem
        }
    })
    proms.push(hotelRecordsFetch)  

    if (programs['clean']) { 
        let auditRecordsFetch = getAuditRecordsForHkeys(hkeys, bypass_cache, bypass_redirect_mapping).then((res) => {
            const defaultKeys = ['auditor_key', 'audit_date', 'program_name', 'link']
            for (let hkey of Object.keys(res)) {
                for (let elem of res[hkey]) {
                    if (!audits[hkey]) audits[hkey] = []
                    let item = {
                        id: elem._id,
                        checked: elem.checked,
                        missed: elem.missed,
                        services: elem.services,
                        protocol_version: elem.version,
                        terms_version: elem.terms,
                        type: elem.type,
                        status: elem.status,
                        created_date: elem._createdDate,
                        updated_date: elem._updatedDate
                    }
                    for (let key of defaultKeys) {
                        if (elem[key]) item[key] = elem[key]
                    }
                    if (!audits[hkey]) audits[hkey] = []
                    audits[hkey].push(item)
                }
            }
        })
        proms.push(auditRecordsFetch)
    }

    if (programs['green']) { 
        let greenTrackingFetch = getGreenTrackingForHkeys(hkeys, bypass_cache).then(res => {
            for (let hkey of Object.keys(res)) {
                let data = {}
                Object.assign(data, res[hkey])
                for (let x of ["hkey", "_id", "_createdDate", "_updatedDate"]) delete data[x]
                greenTrackings[hkey] = data
            }
        })
        proms.push(greenTrackingFetch)       
    
        let greenAuditRecordsFetch = this.getGreenAuditRecordsForHkeys(hkeys, {backfill: backfill}).then((res) => {
            for (let hkey of Object.keys(res)) {
                let elem = res[hkey]
                if (!audits[hkey]) audits[hkey] = []
                audits[hkey].push(elem)
            }
        })
        proms.push(greenAuditRecordsFetch)   
    } 

    if (programs['gsi2']) { 
        let gsi2AuditRecordsFetch = this.getGSI2AuditRecordsForHkeysAndCustomerId(hkeys, customerId, {bypass_cache: bypass_cache}).then((res) => {
            for (let hkey of Object.keys(res)) {
                let elem = res[hkey]
                if (!audits[hkey]) audits[hkey] = []
                audits[hkey].push(elem)
            }
        })
        proms.push(gsi2AuditRecordsFetch)   
    } 

    let res = await Promise.all(proms)
    let data = []
    for (let hkey of hkeys) {
        let obj = {
            hkey: hkey,
            info: infos[hkey],
            audits: audits[hkey],
            green_tracking: greenTrackings[hkey]
        }
        data.push(obj)
    }
    if (flat) {
        data = data.map(val => flatten(val))
        return data
    } else {
        return data
    }
}

exports.getAuditsReport = (where, offset, size) => {
    return new Promise((resolve, reject) => {
        db.query(`SELECT * FROM audits_full ${where} ORDER BY id ASC LIMIT ${offset}, ${size}`, [], (fst) => {
            db.query(`SELECT COUNT(*) as 'count' FROM audits_full ${where}`, [], async (snd) => {
                let proms = []
                for (let item of fst) {
                    const i = await evalAuditRecord(item)
                    proms.push(i)
                }
                Promise.all(proms).then(res => resolve({result: res, total: snd[0]['count']}))
            })
        })
    })
}

exports.getGeosureReport = (where, offset, size) => {
    return new Promise((resolve, reject) => {
        db.query(`SELECT * FROM hotels_gs_view ${where} ORDER BY hkey ASC LIMIT ${offset}, ${size}`, [], (fst) => {
            db.query(`SELECT COUNT(*) as 'count' FROM hotels_gs_view ${where}`, [], async (snd) => {
                let proms = []
                for (let item of fst) {
                    const i = await evalGeosureRecord(item)
                    proms.push(i)
                }
                Promise.all(proms).then(res => resolve({result: res, total: snd[0]['count']}))
            })
        })
    })
}

exports.getGreenAuditsReport = (where, offset, size, backfill_mode) => {
    return new Promise(async (resolve, reject) => {
        let table = backfill_mode ? "green_all_updates_backfilled" : "green_all_records"
        db.query(`SELECT hkey FROM ${table} ${where} ORDER BY hkey ASC LIMIT ${offset}, ${size}`, [], (fst) => {
            db.query(`SELECT COUNT(*) as 'count' FROM ${table} ${where}`, [], (snd) => {
                getGreenAuditRecordsForHkeys(fst.map(x => x.hkey), {backfill: backfill_mode}).then(res => resolve({result: res, total: snd[0]['count']}))
            })
        })
    })
}

exports.getGreenExceptionsReport = (where, offset, size) => {
    return new Promise(async (resolve, reject) => {
        db.query(`SELECT * FROM green_exceptions ${where} ORDER BY _id ASC LIMIT ${offset}, ${size}`, [], (fst) => {
            db.query(`SELECT COUNT(*) as 'count' FROM green_exceptions ${where}`, [], (snd) => {
                let proms = []
                let latestReportYear = 2021
                for (let item of fst) {
                    if (item.opening_date < new Date(latestReportYear+1, 0)) {
                        proms.push(evalGreenExceptionRecord(item))
                    }
                }
                Promise.all(proms).then(res => resolve({result: res, total: snd[0]['count']}))
            })
        })            
    })
}

exports.getGreenTrackingReport = (where, offset, size) => {
    return new Promise((resolve, reject) => {
        db.query(`SELECT * FROM green_tracking ${where} ORDER BY _updatedDate ASC LIMIT ${offset}, ${size}`, [], (fst) => {
            db.query(`SELECT COUNT(*) as 'count' FROM green_tracking ${where}`, [], (snd) => {
                resolve({result: fst, total: snd[0]['count']})
            })
        })
    })
}

exports.getHotelByHKey = (hkey) => {
    return new Promise((resolve, reject) => {
        let hotelRecordsFetch = db.select("hotels", `WHERE hkey = ${hkey}`).then(res => {
            if (res.length === 0) reject(`No hotel entry found for hkey ${hkey}.`)
            resolve(res[0])
        })
    })
}

exports.getHotelsForEmail = (email) => {
    return new Promise((resolve, reject) => {
        db.query(`SELECT * FROM hotels LEFT JOIN emails_lookup ON hotels.hkey = emails_lookup.hkey WHERE emails_lookup.email = '${email}'`, [], resolve)
    })
}

exports.getAllTouchlessStatus = (where, offset, size) => {
    return new Promise((resolve, reject) => {
        db.query(`SELECT * FROM touchless_stay ${where} ORDER BY hkey ASC LIMIT ${offset}, ${size}`, [], (fst) => {
            db.query(`SELECT COUNT(*) as 'count' FROM touchless_stay ${where}`, [], (snd) => {
                fst.forEach(i => i.status = !!i.date)
                resolve({result: fst, total: snd[0]['count']})
            })
        })
    })
}

exports.getSGSAuditById = (id) => {
    return new Promise((resolve, reject) => {
        db.query(`SELECT * FROM sgs_audits_view WHERE audit_id = "${id}" LIMIT 1`, [], (res) => {
            return resolve(res[0])
        })
    })
}

exports.uploadFile = (filename) => {
    return cloudStorage.uploadFile(filename)
}

exports.readFileStream = (filename) => {
    return cloudStorage.readFileStream(filename)
}

exports.getHotelsByChainId = (id) => {
    return new Promise((resolve, reject) => {
        db.query(`SELECT hkey, name, brand, city, country FROM hotels_view WHERE chain_id = ${id} ORDER BY hkey ASC`, [], (res) => {
            resolve(res)
        })
    })
}

exports.getHotelsByAgentId = (id) => {
    return new Promise((resolve, reject) => {
        db.query(`SELECT hkey FROM agents_hotels WHERE agent_id = '${id}'`, [], (res) => {
            if (res.length === 0) return resolve([])
            db.query(`SELECT hkey, name, brand, city, country FROM hotels_view WHERE hkey IN (${res.map(x => x.hkey).join(',')}) ORDER BY hkey ASC`, [], (res) => {
                resolve(res)
            })
        })
    })
}

exports.getChainSampleHotels = (id) => {
    return new Promise((resolve, reject) => {
        return db.query(`SELECT country_id, count(*) as cnt FROM hotels WHERE chain_id = ${id} and country_id <> -1 GROUP BY country_id ORDER BY cnt DESC LIMIT 10`, [], (res) => {
            let proms = []
            res.forEach(rec => {
                let p = new Promise((rslv, rjct) => {
                    db.query(`SELECT * FROM hotels WHERE hkey=(SELECT MAX(hkey) FROM hotels WHERE chain_id = ${id} AND country_id = ${rec.country_id}) AND status = 'open'`, [], (hotels) => {
                        rslv(hotels[0])
                    })
                })
                proms.push(p)
            })
            Promise.all(proms).then(resolve).catch(reject)
        })
    })
}

const evalCheckinConfig = (data) => {
    data.business_requirements = JSON.parse(data.business_requirements)
    data.leisure_requirements = JSON.parse(data.leisure_requirements)
    const today = new Date()
    data.status = data.start_date > today ? 'inactive' : (data.end_date >= today ? 'active' : 'expired')
    data.type = "checkin_config"
    for (let [k,v] of Object.entries(data)) if (!v) delete data[k]
    return data
}

exports.getCheckinConfigByID = (id) => {
    return new Promise((resolve, reject) => {
        return db.query(`SELECT * FROM cs_checkin_config WHERE _id = "${id}"`, [], (res) => {
            if (res.length === 0) resolve(null)
            resolve(evalCheckinConfig(res[0]))
        })
    })
}

const formatDate = (date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`

const cacheCheckinConfigForHkey = (hkey, checkin_date_ref, elem) => {
    cache.set(`checkin:${formatDate(checkin_date_ref)}:${hkey}`, JSON.stringify(elem), 'EX', process.env.REDIS_TTL)
}

const getCachedCheckinConfigsForHkeys = (hkeys, checkin_date_ref) => {
    return new Promise((resolve) => {
        let data = {}
        let proms = hkeys.map((hkey) => new Promise((resolve, reject) => {
            cache.get(`checkin:${formatDate(checkin_date_ref)}:${hkey}`, (err, val) => {
                if (val !== null) data[hkey] = JSON.parse(val)
                resolve()
            })
        }))
        Promise.all(proms).then(_ => {
            resolve(data)
        })
    })   
}

const getCheckinConfigsForHkeysFromDB = (hkeys, checkin_date_ref) => {
    const dateRef = formatDate(checkin_date_ref)
    return new Promise((resolve, reject) => {
        const list = hkeys.map(val => db.escape(val)).join(', ')
        let res = db.query(`SELECT * FROM cs_checkin_config WHERE hkey IN (${list}) AND DATE('${dateRef}') >= start_date AND end_date >= DATE('${dateRef}')`, [], (res) => {
            resolve(res)
        })
    })
}

exports.getCheckinConfigsForHkeys = (hkeys, checkin_date_ref) => {
    return new Promise(async (resolve, reject) => {
        try {
            let res = {}
            hkeys = hkeys.filter((val) => !isNaN(Number(val))).map((val) => Number(val))
            if (hkeys.length === 0) return resolve([])
            res = await getCachedCheckinConfigsForHkeys(hkeys, checkin_date_ref)
            for (let hkey of Object.keys(res)) {
                hkeys.splice(hkeys.indexOf(Number(hkey)), 1)
            }
            if (hkeys.length === 0) return resolve(res)
            let items = await getCheckinConfigsForHkeysFromDB(hkeys, checkin_date_ref)
            let proms = []
            for (let i of items) {
                proms.push(new Promise((rslv, rjt) => {
                    let elem = evalCheckinConfig(i)
                    cacheCheckinConfigForHkey(i.hkey, checkin_date_ref, elem)
                    res[i.hkey] = elem
                    hkeys.splice(hkeys.indexOf(Number(i.hkey)), 1)
                    rslv()
                }))
            }
            await Promise.all(proms)
            resolve(res)
        } catch (err) {
            reject(err)
        }
    })
}

exports.getCachedClientSettings = (clientID) => {
    //console.log("getCachedClientSettings", clientID)
    return new Promise((resolve) => {
        return cache.get(`rate-limit-client:${clientID}`, (err, val) => {
            //console.log(`rate-limit-client:${clientID}`, val)
            if (val !== null) resolve(JSON.parse(val))
            resolve(null)
        })
    })   
}

exports.cacheClientSettings = (clientID, settings) => {
    //console.log(`cacheClientSettings`, settings)
    cache.set(`rate-limit-client:${clientID}`, JSON.stringify(settings), 'EX', process.env.REDIS_TTL)
}

exports.getClientSettingsFromDB = (clientID) => {
    //console.log(`getClientSettingsFromDB`, clientID)
    return new Promise((resolve, reject) => {
        return db.query(`SELECT * FROM api_clients WHERE id = '${clientID}' LIMIT 1`, [], (res) => {
            //console.log(`SELECT * FROM api_clients WHERE id = '${clientID}' LIMIT 1`, res)
            resolve(res[0])
        })
    })
}

let getHotelsWithGreenAudit = () => {
    return new Promise((resolve, reject) => {
        return db.query(`SELECT DISTINCT A.hkey, B.name, B.chain, B.chain_id, B.city, B.country, B.hrs_office FROM green_audits A LEFT JOIN hotels B ON A.hkey = B.hkey`, [], (res) => {
            resolve(res)
        })
    })
}
exports.getHotelsWithGreenAudit = getHotelsWithGreenAudit

let getHotelsWithGreenClaim = () => {
    return new Promise((resolve, reject) => {
        return db.query(`SELECT DISTINCT A.hkey, B.name, B.chain, B.chain_id, B.city, B.country, B.hrs_office FROM green_footprint_claims A LEFT JOIN hotels B ON A.hkey = B.hkey`, [], (res) => {
            resolve(res)
        })
    })
}
exports.getHotelsWithGreenClaim = getHotelsWithGreenClaim

let getHotelsWithGreenException = () => {
    return new Promise((resolve, reject) => {
        return db.query(`SELECT DISTINCT A.hkey, B.name, B.chain, B.chain_id, B.city, B.country, B.hrs_office FROM green_exceptions A LEFT JOIN hotels B ON A.hkey = B.hkey`, [], (res) => {
            resolve(res)
        })
    })
}
exports.getHotelsWithGreenException = getHotelsWithGreenException

let getHotelsWithGreenProgram = () => {
    return new Promise((resolve, reject) => {
        return db.query(`SELECT DISTINCT A.hkey, B.name, B.chain, B.chain_id, B.city, B.country, B.hrs_office FROM green_programs A LEFT JOIN hotels B ON A.hkey = B.hkey`, [], (res) => {
            resolve(res)
        })
    })
}
exports.getHotelsWithGreenProgram = getHotelsWithGreenProgram

let getHotelsWithGreenCert = () => {
    return new Promise((resolve, reject) => {
        return db.query(`SELECT DISTINCT A.hkey, B.name, B.chain, B.chain_id, B.city, B.country, B.hrs_office FROM green_certificates A LEFT JOIN hotels B ON A.hkey = B.hkey`, [], (res) => {
            resolve(res)
        })
    })
}
exports.getHotelsWithGreenCert = getHotelsWithGreenCert

let getHotelsWithGSI2Report = () => {
    return new Promise((resolve, reject) => {
        return db.query(`SELECT DISTINCT A.hkey, B.name, B.chain, B.chain_id, B.city, B.country, B.hrs_office FROM gsi2_reports A LEFT JOIN hotels B ON A.hkey = B.hkey`, [], (res) => {
            resolve(res)
        })
    })
}
exports.getHotelsWithGSI2Report = getHotelsWithGSI2Report