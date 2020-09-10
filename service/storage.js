const cache = require('../client/cache')
const crypto = require('crypto')
const db = require('../client/database')
const cloudStorage = require('../client/cloud-storage')
const request = require('request')
const flatten = require('flat')
const logger = require('../utils/logger')

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

const cacheAuditRecordForHkey = (hkey, elem) => {
    let key = crypto.createHash('md5').update(JSON.stringify(elem)).digest('hex')
    cache.set(key, JSON.stringify(elem), 'EX', process.env.REDIS_TTL);
    cache.sadd(hkey, key)
    cache.expire(hkey, process.env.REDIS_TTL)
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

exports.getTouchlessStatusForHkeys = (hkeys) => {
    return getCachedTouchlessStatusForHKeys(hkeys).then((res) => {
        const hkeysFromCache = Object.keys(res)
        let touchlessHkeys = new Set(hkeysFromCache.map(e => Number(e)))

        let leftHkeys = hkeys.filter( el => hkeysFromCache.indexOf(el) < 0 )
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
            return Array.from(touchlessHkeys)
        })
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

exports.getHotelStatusByHkeys = async (hkeys, flat = false, bypass_cache = false, bypass_redirect_mapping = false, bypass_full_email_reporting = false, exclude = []) => {
    let filter = ''
    filter = `WHERE hkey IN (${hkeys})`

    let infos = {}
    let audits = {}

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
                "share_self_assessment_link": "https://www.hotel-audit.hrs.com/individual-assessment/"+i.hkey+"/"+i.code+"?utm_source=hrs-hs&utm_medium=email&utm_campaign=individual_invitation&utm_content="+i.hkey
            }
            for (let key of exclude) delete elem[key]
            infos[i.hkey] = elem
        }
    })
    proms.push(hotelRecordsFetch)

    let inspections = {}
    let inspectionRecordFetch = db.select("inspection_waitlist", filter).then(async (items) => {
        for (let i of items) {
            let elem = {
                "signed_date": i.signed_date,
                status: i.status
            }
            inspections[i.hkey] = elem
        }
    })
    proms.push(inspectionRecordFetch)

    let emails = {}
    if (!bypass_full_email_reporting) {
        let emailRecordFetch = db.select("email_campaign_invitation_performance", filter + " AND status IN ('Sent','Bounced','Failed')").then(async (items) => {
            for (let i of items) {
                for (let key of ['opt_out', 'open', 'click']) i[key] = !!i[key]
                if (!(i.hkey in emails)) emails[i.hkey] = []
                const hkey = i.hkey
                delete i.hkey
                emails[hkey].push(i)
            }
        })
        proms.push(emailRecordFetch)
    }

    let email_stats = {}
    let emailStatsFetch = db.select("email_performance_stats", filter).then(async (items) => {
        for (let i of items) {
            const hkey = i.hkey
            delete i.hkey
            email_stats[hkey] = i
        }
    })
    proms.push(emailStatsFetch)

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
                audits[hkey].push(item)
            }
        }
    })
    proms.push(auditRecordsFetch)

    let res = await Promise.all(proms)
    let data = []
    for (let hkey of hkeys) {
        let obj = {
            hkey: hkey,
            info: infos[hkey],
            audits: audits[hkey],
            inspections: inspections[hkey],
            email_stats: email_stats[hkey]
        }
        if (!bypass_full_email_reporting) obj.emails = emails[hkey]
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
            db.query(`SELECT COUNT(*) as 'count' FROM audits_full ${where}`, [], (snd) => {
                let proms = []
                for (let item of fst) {
                    const i = evalAuditRecord(item)
                    proms.push(i)
                }
                Promise.all(proms).then(res => resolve({result: res, total: snd[0]['count']}))
            })
        })
    })
}

exports.getChainStatus = (id) => {
    return new Promise((resolve, reject) => {
        db.query(`SELECT * FROM chains WHERE id = ${db.escape(id)} LIMIT 1`, [], (res) => {
            return resolve(res[0])
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

exports.getClients = (id) => {
    return new Promise((resolve, reject) => {
        db.query(`SELECT * FROM clients`, [], (res) => {
            return resolve(res)
        })
    })
}

exports.getClientDataForId = (id) => {
    return new Promise((resolve, reject) => {
        db.query(`SELECT * FROM 2020_rfp A LEFT JOIN rfps B ON A.rfp_id = B.id WHERE B.client_id = ${db.escape(id)} AND rfp_status = 'accepted'`, [], (res) => {
            return resolve(res)
        })
    })
}