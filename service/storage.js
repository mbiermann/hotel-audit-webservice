const cache = require('../client/cache')
const crypto = require('crypto')
const db = require('../client/database')
const cloudStorage = require('../client/cloud-storage')
const request = require('request')
const flatten = require('flat')
const logger = require('../utils/logger')

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

let getGreenhouseGasFactors = (i) => {

    return new Promise((resolve, reject) => {
        const cache_key = "ghg_factors"
        cache.get(cache_key, (err, val) => { 
            if (!!val) {
                resolve(JSON.parse(val))
            } else {
                let refrigeratorFactors = db.select("refrigerator_emission_factors")
                let fuelFactors = db.select("mobilefuels_emission_factors")
                let electricityFactors = db.select(`electricity_emission_factors_${i.report_year}`)

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

let evalGreenAuditRecord = (i) => {
    return new Promise((resolve, reject) => {

        getGreenhouseGasFactors(i).then(async factors => {

            let total_electricity_kwh = i.total_electricity_kwh || 0
            let total_gas_kwh = i.total_gas_kwh || 0
            let total_oil_litres = i.total_oil_litres || 0

            let shareRoomsToMeetingSpaces = i.total_guest_room_corridor_area_sqm / (i.total_guest_room_corridor_area_sqm + i.total_meeting_space_sqm)

            // Evaluate water consumption
            let consumedWater = i.total_metered_water + i.total_unmetered_water - i.total_sidebar_water - i.onsite_waste_water_treatment
            let totalWaste = i.landfill_waste_cm

            if (i.is_privatespace_available) {
                let privateSpaceShare = i.total_privatespace_sqm / i.total_conditioned_area_sqm
                if (i.privatespace_total_electricity_kwh > 0 || i.privatespace_total_oil_litres > 0 || i.privatespace_total_gas_kwh > 0) {
                    total_electricity_kwh -= i.privatespace_total_electricity_kwh
                    total_oil_litres -= i.privatespace_total_oil_litres
                    total_gas_kwh -= i.privatespace_total_gas_kwh
                    consumedWater -= i.privatespace_total_water
                } else if (i.total_privatespace_sqm > 0) {
                    total_electricity_kwh -= total_electricity_kwh * privateSpaceShare
                    total_oil_litres -= total_oil_litres * privateSpaceShare
                    total_gas_kwh -= total_gas_kwh * privateSpaceShare
                    consumedWater -= consumedWater * privateSpaceShare
                }
                totalWaste -= totalWaste * privateSpaceShare // Always, as we don't request specific figures
            }

            if (i.is_laundry_outsourced) {
                if (i.laundry_total_electricity_kwh > 0 || i.laundry_total_oil_litres > 0 || i.laundry_total_gas_kwh > 0) {
                    total_electricity_kwh += i.laundry_total_electricity_kwh
                    total_oil_litres += i.laundry_total_oil_litres
                    total_gas_kwh += i.laundry_total_gas_kwh
                    consumedWater += i.laundry_total_water
                } else if (i.laundry_metric_tons > 0) {
                    total_electricity_kwh += 180 * i.laundry_metric_tons
                    total_oil_litres += 111 * i.laundry_metric_tons
                    total_gas_kwh += 1560 * i.laundry_metric_tons
                    consumedWater += 20000 * i.laundry_metric_tons // HWMI
                }
            }

            let lH2OPOC = (shareRoomsToMeetingSpaces * consumedWater) / i.total_occupied_rooms
            const h2OClasses = ['A','B','C','D']
            let waterThresholds = [150,300,600,800] // Based on https://www.sciencedirect.com/science/article/abs/pii/S026151771400137X?via%3Dihub, https://www.mdpi.com/2071-1050/11/23/6880/pdf
            let waterClass = 'D'
            for (let i = 0; i < waterThresholds.length; i++) {
                if (lH2OPOC <= waterThresholds[i]) {
                    waterClass = h2OClasses[i]
                    break
                }
            }

            /*if (i.is_renewable_energy_used) {
                if (i.total_renewable_energy_purchased_kwh > 0) {
                    total_electricity_kwh -= i.total_renewable_energy_purchased_kwh
                } 
                if (i.total_renewable_energy_generated_kwh > 0) {
                    total_electricity_kwh -= i.total_renewable_energy_generated_kwh
                }
            }*/

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
            }

            // Evaluate waste consumption (1cm contains approx. 125kg of landfill waste: https://www.wien.gv.at/umweltschutz/abfall/pdf/umrechnungsfaktoren.pdf)
            let kgWastePOC = (shareRoomsToMeetingSpaces * (125*totalWaste)) / i.total_occupied_rooms
            const wasteClasses = ['A','B','C','D']
            let wasteThresholds = [0.3,0.6,1]
            let wasteClass = 'D'
            for (let i = 0; i < wasteThresholds.length; i++) {
                if (kgWastePOC <= wasteThresholds[i]) {
                    wasteClass = wasteClasses[i]
                    break
                }
            }

            let kgCo2eElectrictiy = total_electricity_kwh * factors.electricity[i.electricity_emission_location]
            let kgCo2eOil = total_oil_litres * factors.mobile_fuels.diesel
            let kgCo2eGas = total_gas_kwh * factors.mobile_fuels.gas
            totalKgCo2e += (kgCo2eElectrictiy + kgCo2eOil + kgCo2eGas)

            let kgCo2ePOC = (shareRoomsToMeetingSpaces * totalKgCo2e) / i.total_occupied_rooms
            
            // Index values based on CHSB2020 M1 countries only LowerQ, Mean, UpperQ
            const classes = ['A','B','C','D']
            let thresholds = [19,31,38]
            // Update default benchmark values with location-specific benchmark if exists
            let benchmark = await db.select("green_benchmark", `WHERE location_id = '${i.electricity_emission_location}' AND reporting_year <= '${i.report_year}'`)
            if (benchmark.length > 0) {
                thresholds = [benchmark[0].A, benchmark[0].B, benchmark[0].C]
            }
            
            let carbonClass = 'D'
            for (let i = 0; i < thresholds.length; i++) {
                if (kgCo2ePOC <= thresholds[i]) {
                    carbonClass = classes[i]
                    break
                }
            }

            let greenClassIdx = Math.round((classes.indexOf(carbonClass)+1)*0.6+(h2OClasses.indexOf(waterClass)+1)*0.2+(wasteClasses.indexOf(wasteClass)+1)*0.2)
            let greenClass = classes[greenClassIdx-1]

            let program = await getProgram(i.hkey)
            let cert = await getLastCertificate(i.hkey)
            
            let rec = {}
            rec.hkey = i.hkey
            rec.id = i._id
            rec.created_date = i._createdDate
            rec.updated_date = i._updatedDate
            rec.report_year = i.report_year
            rec.kilogramCarbonPOC = kgCo2ePOC
            rec.literWaterPOC = lH2OPOC
            rec.kilogramWastePOC = kgWastePOC
            rec.carbonClass = carbonClass
            rec.waterClass = waterClass
            rec.wasteClass = wasteClass
            rec.greenClass = greenClass
            if (program) rec.program = select(['name', 'link'], program)
            if (cert) rec.cert = select(['cert_id', 'validity_start', 'validity_end', 'url', 'issuer'], cert)
            rec.type = "green_stay_self_inspection"
            if (greenClass === "A") rec.type = `${rec.type}_hero`
            rec.status = true

            resolve(rec)
        })
        
    })
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
        rec.status = true
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

const getLastCertificate = async (hkey) => {
    let res = await db.select('green_certificates', `WHERE hkey = ${hkey}`, '*', 'ORDER BY validity_end DESC', 0, 1)
    return res[0]
}

const cacheAuditRecordForHkey = (hkey, elem) => {
    let key = crypto.createHash('md5').update(JSON.stringify(elem)).digest('hex')
    cache.set(key, JSON.stringify(elem), 'EX', process.env.REDIS_TTL);
    cache.sadd(hkey, key)
    cache.expire(hkey, process.env.REDIS_TTL)
}

const cacheGreenAuditRecordForHkey = (hkey, elem) => {
    cache.set(`green:${hkey}`, JSON.stringify(elem), 'EX', process.env.REDIS_TTL);
}

const cacheGreenExceptionRecordForHkey = (hkey, elem) => {
    cache.set(`green_exception:${hkey}`, JSON.stringify(elem), 'EX', process.env.REDIS_TTL);
}

const cacheGreenTrackingForHkey = (hkey, elem) => {
    cache.set(`green_tracking:${hkey}`, JSON.stringify(elem), 'EX', process.env.REDIS_TTL);
}

const getCachedGreenAuditRecordsForHkeys = (hkeys) => {
    return new Promise((resolve, reject) => {
        let data = {}
        let proms = []
        for (let hkey of hkeys) {
            proms.push(new Promise((resolve1) => {
                cache.get(`green:${hkey}`, (err, val) => {
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

exports.getGreenAuditRecordsForHkeys = (hkeys, options) => {
    return new Promise(async (resolve, reject) => {
        try {
            hkeys = hkeys.filter((val) => !isNaN(Number(val))).map((val) => Number(val))
            if (hkeys.length === 0) return resolve([])
            let records = (options && options.bypass_cache) ? {} : (await getCachedGreenAuditRecordsForHkeys(hkeys))
            const hkeysFromCache = Object.keys(records).map(e => Number(e))
            let leftHkeys = hkeys.filter( el => hkeysFromCache.indexOf(Number(el)) < 0 )
            if (leftHkeys.length === 0) return resolve(records)
            let filter = `WHERE hkey IN (${leftHkeys})`
            let greenAudits = await db.select("green_audits", filter)
            let evals = []
            let latestYears = {}
            greenAudits.forEach(item => {
                if (!latestYears[item.hkey] || item.report_year > latestYears[item.hkey]) {
                    evals.push(evalGreenAuditRecord(item))
                    latestYears[item.hkey] = item.report_year
                }
            })
            return Promise.all(evals).then(res => {
                res.forEach(e => {
                    cacheGreenAuditRecordForHkey(e.hkey, e)
                    records[e.hkey] = e
                })
                resolve(records)
            })
            
        } catch (err) {
            reject(err)
        }
    })
}

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

exports.getGreenExceptionRecordsForHkeys = (hkeys, options) => {
    return new Promise(async (resolve, reject) => {
        try {
            hkeys = hkeys.filter((val) => !isNaN(Number(val))).map((val) => Number(val))
            if (hkeys.length === 0) return resolve([])
            let records = (options && options.bypass_cache) ? {} : (await getCachedGreenExceptionRecordsForHkeys(hkeys))
            const hkeysFromCache = Object.keys(records).map(e => Number(e))
            let leftHkeys = hkeys.filter( el => hkeysFromCache.indexOf(Number(el)) < 0 )
            if (leftHkeys.length === 0) return resolve(records)
            let filter = `WHERE hkey IN (${leftHkeys})`
            let greenExcs = await db.select("green_exceptions", filter)
            let evals = []
            let latestReportYear = 2019
            greenExcs.forEach(item => {
                // Only pass exceptions when younger than begin of latest report year
                if (item.opening_date < new Date(latestReportYear+1, 0)) {
                    evals.push(evalGreenExceptionRecord(item))
                }
            })
            return Promise.all(evals).then(res => {
                res.forEach(e => {
                    cacheGreenExceptionRecordForHkey(e.hkey, e)
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
                if (res.length === 0) return reject(new Error(`No green report found for ID ${id}`))
                resolve(evalGreenAuditRecord(res[0]))
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

exports.getHotelStatusByHkeys = async (hkeys, programs, flat = false, bypass_cache = false, bypass_redirect_mapping = false, exclude = []) => {
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
    
        let greenAuditRecordsFetch = this.getGreenAuditRecordsForHkeys(hkeys).then((res) => {
            for (let hkey of Object.keys(res)) {
                let elem = res[hkey]
                if (!audits[hkey]) audits[hkey] = []
                audits[hkey].push(elem)
            }
        })
        proms.push(greenAuditRecordsFetch)   
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

exports.getGreenAuditsReport = (where, offset, size) => {
    return new Promise(async (resolve, reject) => {
        db.query(`SELECT * FROM green_audits ${where} ORDER BY _id ASC LIMIT ${offset}, ${size}`, [], (fst) => {
            db.query(`SELECT COUNT(*) as 'count' FROM green_audits ${where}`, [], (snd) => {
                let proms = []
                for (let item of fst) {
                    const i = evalGreenAuditRecord(item)
                    proms.push(i)
                }
                Promise.all(proms).then(res => resolve({result: res, total: snd[0]['count']}))
            })
        })
    })
}

exports.getGreenExceptionsReport = (where, offset, size) => {
    return new Promise(async (resolve, reject) => {
        db.query(`SELECT * FROM green_exceptions ${where} ORDER BY _id ASC LIMIT ${offset}, ${size}`, [], (fst) => {
            db.query(`SELECT COUNT(*) as 'count' FROM green_exceptions ${where}`, [], (snd) => {
                let proms = []
                let latestReportYear = 2019
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