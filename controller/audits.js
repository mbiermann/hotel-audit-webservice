const express = require('express')
const router = express.Router()
const storage = require('../service/storage')
const logger = require('../utils/logger')
const { trackEvent } = require('../service/tracking')
const { combinedAuthMiddleware: combinedAuthMiddleware } = require('../utils/auth-middleware')
const { Logging } = require('@google-cloud/logging')
const Excel = require('exceljs')
const { writeToString } = require('@fast-csv/format')
const flatten = require('flat')
const xlsx = require('node-xlsx')
const CryptoJS = require('crypto-js')
const fs = require('fs')
const { select } = require('../model/green')
const testData = JSON.parse(fs.readFileSync('./gsi2-testing.json', 'utf8'))

let projectId = process.env.GC_PROJECT_ID
const logging = new Logging({ projectId });
const logName = process.env.GC_FETCHLOG
const auditFetchLog = logging.log(logName);

router.get('/report', combinedAuthMiddleware, async (req, resp) => {
    
    if (!!req.query && !!req.query.page && !!req.query.size) {
        let page = Number(req.query.page)
        if (isNaN(page) || page === 0) page = 1
        let size = Number(req.query.size)
        if (isNaN(size)) size = 10
        if (size > 500) size = 500
        let offset = (page > 1 ? (page - 1) * size : 0)
        let where = ''
        if (('since' in req.query)) {
            if (!(/[0-9]{4}\-[0-9]{2}\-[0-9]{2}/.test(req.query.since))) {
                return resp.status(403).send({ message: 'Invalid use of parameter ´since´!' })
            }
            where = `WHERE DATE(updated_date) >= '${req.query.since}'`
        }
        storage.getAuditsReport(where, offset, size).then((res) => {
            resp.status(200).json({ results: res.result, page_number: page, page_size: size, total_pages: Math.ceil(res.total / size) });
        })   
    } else {
        resp.sendStatus(403)
    }

})

router.get('/report/touchlessstay', combinedAuthMiddleware, async (req, resp) => {
    if (!!req.query && !!req.query.page && !!req.query.size) {
        let page = Number(req.query.page)
        if (isNaN(page) || page === 0) page = 1
        let size = Number(req.query.size)
        if (isNaN(size)) size = 10
        if (size > 500) size = 500
        let offset = (page > 1 ? (page - 1) * size : 0)

        let where = ''
        if (('since' in req.query)) {
            if (!(/[0-9]{4}\-[0-9]{2}\-[0-9]{2}/.test(req.query.since))) {
                return resp.status(403).send({ message: 'Invalid use of parameter ´since´!' })
            }
            where = `WHERE DATE(date) >= '${req.query.since}'`
        }
    
        storage.getAllTouchlessStatus(where, offset, size).then((res) => {
            resp.status(200).json({ results: res.result, page_number: page, page_size: size, total_pages: Math.ceil(res.total / size) });
        })
                
    } else {
        resp.sendStatus(403)
    }
})

router.get('/report/green_tracking', combinedAuthMiddleware, async (req, resp) => {
    
    if (!!req.query && !!req.query.page && !!req.query.size) {
        let page = Number(req.query.page)
        if (isNaN(page) || page === 0) page = 1
        let size = Number(req.query.size)
        if (isNaN(size)) size = 10
        if (size > 500) size = 500
        let offset = (page > 1 ? (page - 1) * size : 0)

        let where = ''
        if (('since' in req.query)) {
            if (!(/[0-9]{4}\-[0-9]{2}\-[0-9]{2}/.test(req.query.since))) {
                return resp.status(403).send({ message: 'Invalid use of parameter ´since´!' })
            }
            where = `WHERE DATE(_updatedDate) >= '${req.query.since}'`
        }

        storage.getGreenTrackingReport(where, offset, size).then((res) => {
            resp.status(200).json({ results: res.result, page_number: page, page_size: size, total_pages: Math.ceil(res.total / size) });
        })
            
    } else {
        resp.sendStatus(403)
    }

})

router.get('/report/green', combinedAuthMiddleware, async (req, resp) => {
    if (!!req.query && !!req.query.page && !!req.query.size) {
        let page = Number(req.query.page)
        if (isNaN(page) || page === 0) page = 1
        let size = Number(req.query.size)
        if (isNaN(size)) size = 10
        if (size > 500) size = 500
        let offset = (page > 1 ? (page - 1) * size : 0)
        let where = ''
        if (('since' in req.query)) {
            if (!(/[0-9]{4}\-[0-9]{2}\-[0-9]{2}/.test(req.query.since)))
                return resp.status(403).send({ message: 'Invalid use of parameter ´since´!' })
            where = `WHERE DATE(_updatedDate) >= '${req.query.since}'`
        }
        storage.getGreenAuditsReport(where, offset, size, ("true" == req.query.backfill)).then((res) => {
            resp.status(200).json({ results: res.result, page_number: page, page_size: size, total_pages: Math.ceil(res.total / size) });
        })   
    } else {
        resp.sendStatus(403)
    }
})

router.get('/report/gsi2', combinedAuthMiddleware, async (req, resp) => {
    if (!!req.query && !!req.query.page && !!req.query.size) {
        let page = Number(req.query.page)
        if (isNaN(page) || page === 0) page = 1
        let size = Number(req.query.size)
        if (isNaN(size)) size = 10
        if (size > 500) size = 500
        let offset = (page > 1 ? (page - 1) * size : 0)
        let where = ''
        if (('since' in req.query)) {
            if (!(/[0-9]{4}\-[0-9]{2}\-[0-9]{2}/.test(req.query.since)))
                return resp.status(403).send({ message: 'Invalid use of parameter ´since´!' })
            where = `WHERE DATE(_updatedDate) >= '${req.query.since}'`
        }
        storage.getGSI2AuditsReport(where, offset, size, ("true" == req.query.backfill)).then((res) => {
            resp.status(200).json({ results: res.result, page_number: page, page_size: size, total_pages: Math.ceil(res.total / size) });
        })   
    } else {
        resp.sendStatus(403)
    }
})

router.get('/report/green_exceptions', combinedAuthMiddleware, async (req, resp) => {
    if (!!req.query && !!req.query.page && !!req.query.size) {
        let page = Number(req.query.page)
        if (isNaN(page) || page === 0) page = 1
        let size = Number(req.query.size)
        if (isNaN(size)) size = 10
        if (size > 500) size = 500
        let offset = (page > 1 ? (page - 1) * size : 0)
        let where = ''
        if (('since' in req.query)) {
            if (!(/[0-9]{4}\-[0-9]{2}\-[0-9]{2}/.test(req.query.since)))
                return resp.status(403).send({ message: 'Invalid use of parameter ´since´!' })
            where = `WHERE DATE(_updatedDate) >= '${req.query.since}'`
        }
        storage.getGreenExceptionsReport(where, offset, size).then((res) => {
            resp.status(200).json({ results: res.result, page_number: page, page_size: size, total_pages: Math.ceil(res.total / size) });
        })   
    } else {
        resp.sendStatus(403)
    }
})

router.get('/report/geosure', combinedAuthMiddleware, async (req, resp) => {
    if (!!req.query && !!req.query.page && !!req.query.size) {
        let page = Number(req.query.page)
        if (isNaN(page) || page === 0) page = 1
        let size = Number(req.query.size)
        if (isNaN(size)) size = 10
        if (size > 500) size = 500
        let offset = (page > 1 ? (page - 1) * size : 0)
        let where = ''
        if (('since' in req.query)) {
            if (!(/[0-9]{4}\-[0-9]{2}\-[0-9]{2}/.test(req.query.since))) {
                return resp.status(403).send({ message: 'Invalid use of parameter ´since´!' })
            }
            where = `WHERE DATE(date) >= '${req.query.since}'`
        }
        storage.getGeosureReport(where, offset, size).then((res) => {
            resp.status(200).json({ results: res.result, page_number: page, page_size: size, total_pages: Math.ceil(res.total / size) });
        })   
    } else {
        resp.sendStatus(403)
    }
})


router.get('/', combinedAuthMiddleware, async (req, resp) => {

    let startDate = new Date()
    let checkinDate = new Date()
    
    let hkeys = []
    if (!!req.query && !!req.query.hkeys) hkeys = req.query.hkeys.split(',')
    let exclude = []
    if (!!req.query && !!req.query.exclude) exclude = req.query.exclude.split(',')
    let include = []
    if (!!req.query && !!req.query.include) include = req.query.include.split(',')
    if (include.length > 0) {
        exclude = ['touchless','cleansafe','green','gsi2','geosure','checkin'].filter(x => include.indexOf(x) === -1)
    }
    let configKey = req.query.config_key    

    if (!!req.query && !!req.query.checkin_date) {
        if (!(/[0-9]{4}\-[0-9]{2}\-[0-9]{2}/.test(req.query.checkin_date))) {
            return resp.status(403).send({ message: 'Invalid use of parameter ´checkin_date´!' })
        } else {
            checkinDate = new Date(Date.parse(req.query.checkin_date))
        }
    }

    let touchless = (exclude.includes('touchless')) ? null : storage.getTouchlessStatusForHkeys(hkeys)
    let cleansafe = (exclude.includes('cleansafe')) ? null : storage.getAuditRecordsForHkeys(hkeys, ('true' == req.query.bypass_cache))
    let green = (exclude.includes('green')) ? null : storage.getGreenAuditRecordsForHkeys(hkeys, {backfill: ("true" == req.query.backfill), bypass_cache: ('true' == req.query.bypass_cache)})
    let gsi2 = (exclude.includes('gsi2')) ? null : storage.getGSI2AuditRecordsForHkeysAndConfigKey(hkeys, configKey, {bypass_cache: ("true" == req.query.bypass_cache), backfill: ("true" == req.query.backfill)})
    let geosure = (exclude.includes('geosure')) ? null : storage.getGeosureRecordsForHkeys(hkeys)
    let checkin = (exclude.includes('checkin')) ? null : storage.getCheckinConfigsForHkeys(hkeys, checkinDate)

    Promise.all([touchless, cleansafe, green, gsi2, geosure, checkin]).then(async (result) => {
        let _touchless = result[0]
        let _cleansafe = result[1]
        let _green = result[2]
        let _gsi2 = result[3] 
        let _geosure = result[4]
        let _checkin = result[5]

        let data = {}
        let csTouchlessCheckin = new Set()
        
        if (!(exclude.includes('cleansafe'))) {
            const defaultKeys = ['auditor_key', 'audit_date', 'program_name', 'link']
            for (let hkey of Object.keys(_cleansafe)) {
                for (let elem of _cleansafe[hkey]) {
                    if (!data[hkey]) data[hkey] = []
                    let item = {
                        id: elem._id,
                        type: elem.type,
                        status: elem.status,
                        created_date: elem._createdDate,
                        updated_date: elem._updatedDate
                    }
                    for (let key of defaultKeys) {
                        if (elem[key]) item[key] = elem[key]
                    }
                    data[hkey].push(item)
                    if (!!elem.status && elem.checked.split(',').indexOf("13") > -1) csTouchlessCheckin.add(hkey)
                }
            }
        }        

        for (let hkey of hkeys) {
            if (!(exclude.includes('touchless'))) {
                if (csTouchlessCheckin.has(hkey) || _touchless.indexOf(Number(hkey)) > -1) {
                    if (!(hkey in data)) data[hkey] = []
                    data[hkey].push({
                        type: 'touchless_stay',
                        status: true
                    })
                }
            }
            if (!(exclude.includes('green'))) {
                if (hkey in _green) {
                    if (!(hkey in data)) data[hkey] = []
                    let record = _green[hkey]
                    // Fix for Marriott in GSI1
                    if (record.chain_id == 15) {
                        record.kilogramCarbonPOC = -1
                        record.literWaterPOC = -1
                        record.kilogramWastePOC = -1
                        record.carbonClass = ""
                        record.waterClass = ""
                        record.wasteClass = ""
                        record.greenClass = ""
                        delete record.chain_id
                    }
                    delete record.hkey
                    data[hkey].push(record)
                } else { // The case where the hotel has no footprint claim and report
                    if (!(hkey in data)) data[hkey] = []
                    const programs = await storage.getPrograms(hkey)
                    const cert = await storage.getLastCertificate(hkey)
                    const record = {};
                    if (programs.length > 0) record.program = select(['name', 'link'], programs[0])
                    if ('cert_id' in cert) record.cert = select(['cert_id', 'validity_start', 'validity_end', 'url', 'issuer'], cert)
                    data[hkey].push(record)
                }
            }
            if (!(exclude.includes('gsi2'))) {
                if (('procurement-testing' == req.query.environment) && (hkey in testData.tests)) {
                    if (!(hkey in data)) data[hkey] = []
                    data[hkey].push(testData.scenarios[testData.tests[hkey]])    
                } else if (hkey in _gsi2) {
                    if (!(hkey in data)) data[hkey] = []
                    let record = _gsi2[hkey]
                    delete record.hkey
                    if (record.type !== 'gsi2_not_available') data[hkey].push(record)
                }
            }
            if (!(exclude.includes('geosure'))) {
                if (hkey in _geosure) {
                    if (!(hkey in data)) data[hkey] = []
                    delete _geosure[hkey].hkey
                    data[hkey].push(_geosure[hkey])
                }
            }
            if (!(exclude.includes('checkin'))) {
                if (hkey in _checkin) {
                    if (!(hkey in data)) data[hkey] = []
                    delete _checkin[hkey].hkey
                    _checkin[hkey].checkin_date_ref = checkinDate
                    data[hkey].push(_checkin[hkey])
                }
            }
        }

        trackEvent('Audit Web Service', 'Audits Request Success', req.query.hkeys)
        logger.logEvent(logger.EventServiceResponse, { "url": req.originalUrl, "status": 200 })
        let endDate = new Date()
        let dur = (endDate.getTime() - startDate.getTime()) / hkeys.length
        const entry = auditFetchLog.entry(
            { resource: { type: 'global' } },
            { endDate: endDate, numHkeys: hkeys.length, fetchDuration: dur }
        )
        await auditFetchLog.write(entry)
        resp.status(200).json(data)
    }).catch((err) => {
        console.log("Error on /audits:", err)
        trackEvent('Audit Web Service', 'Audits Request Failure', req.query.hkeys)
        logger.logEvent(logger.EventServiceResponse, { "url": req.originalUrl, "status": 500, "error": "Server Error" })
        resp.status(500).json({ error: 'Server Error' })
    })  
    
})

router.get('/green/reports/all', combinedAuthMiddleware, async (req, resp) => {
    resp.setHeader('Content-Disposition', 'attachment;filename=green-report.zip')
    storage.readFileStream('green_out_xlsx.zip').pipe(resp)
})

router.get('/gsi2/reports/all', combinedAuthMiddleware, async (req, resp) => {
    resp.setHeader('Content-Disposition', 'attachment;filename=gsi2-report.zip')
    storage.readFileStream('gsi2_out_xlsx.zip').pipe(resp)
})

router.get('/green/reports/SoC', combinedAuthMiddleware, async (req, resp) => {
    storage.getHkeysForCustomer('SoC').then(hotels => {
        const hkeys = hotels.map(x => x.hkey)
        storage.getGreenAuditRecordsForHkeys(hkeys, {bypass_cache: true}).then(res => {
            let headers = []
            let data = {}
            hotels.forEach(x => {
                data[x.hkey] = flatten({...x, ...res[x.hkey]}, {delimiter: "_"})
                Object.keys(data[x.hkey]).forEach(h => {
                    if (headers.indexOf(h) === -1) headers.push(h)
                })
            })
            let out = []
            out.push(headers)            
            hkeys.forEach(x => {
                let rec = []
                if (x in data) {
                    headers.forEach(h => rec.push(data[x][h]))
                } else {
                    headers.forEach(h => rec.push((h === 'hkey') ? x : null))
                }
                out.push(rec)
            })   
            var buffer = xlsx.build([{name: "report", data: out}])
            resp.set('Content-Type', 'application/octet-stream')
            resp.attachment(`Green Stay - Hotel Group Status Report - SoC.xlsx`)
            resp.status(200).send(buffer)
        }).catch(err => {
            trackEvent('Audit Web Service', 'Green Audit Group Report Failure', "SoC")
            logger.logEvent(logger.EventServiceResponse, { "url": req.originalUrl, "status": 500, "error": "Server Error" })
            resp.status(500).json({ error: 'Server Error' })
        })
    })
})

router.get('/green/reports/:id', combinedAuthMiddleware, async (req, resp) => {
    storage.getGreenAuditForReportId(req.params.id).then(res => {
        resp.status(200).json(res)
    }).catch(err => {
        trackEvent('Audit Web Service', 'Green Audit Request Failure', req.query.hkeys)
        logger.logEvent(logger.EventServiceResponse, { "url": req.originalUrl, "status": 500, "error": "Server Error" })
        resp.status(500).json({ error: 'Server Error' })
    })
})

router.get('/green/reports/hotel/:hkey', combinedAuthMiddleware, async (req, resp) => {
    let options = {bypass_cache: (req.query["bypass_cache"] === "true")} 
    storage.getGreenAuditRecordsForHkeys([req.params.hkey], options).then(res => {
        if (res[req.params.hkey]) {
            resp.status(200).json(res[req.params.hkey])
        } else {
            resp.status(404).json({ error: 'Not found' })
        }
    }).catch(err => {
        trackEvent('Audit Web Service', 'Green Audit Request Failure', req.paams.hkey)
        logger.logEvent(logger.EventServiceResponse, { "url": req.originalUrl, "status": 500, "error": "Server Error" })
        resp.status(500).json({ error: 'Server Error' })
    })
})

router.get('/green/reports/group/:code', async (req, resp) => {
    if (!("code" in req.params)) return resp.sendStatus(403)
    let bytes = null
    let dec = null
    try {
        bytes = CryptoJS.AES.decrypt(CryptoJS.enc.Hex.parse(req.params.code).toString(CryptoJS.enc.Base64), process.env.CERT_PASS)
        dec = bytes.toString(CryptoJS.enc.Utf8)
    } catch (err) {
        return resp.sendStatus(403)
    }
    if (dec.length === 0) return resp.sendStatus(403)
    let codeData = JSON.parse(dec)
    
    let fun = codeData.type === "AGENT" ? storage.getHotelsByAgentId : storage.getHotelsByChainId
    fun(codeData.id).then(hotels => {
        const hkeys = hotels.map(x => x.hkey)
        //storage.getGreenAuditRecordsForHkeys(hkeys, {bypass_cache: true, full_certs_and_programs: true}).then(res => {
        storage.getGSI2AuditRecordsForHkeysAndConfigKey(hkeys, "0", {bypass_cache: true, full_certs_and_programs: true}).then(res => {
            let headers = []
            let data = {}
            hotels.forEach(x => {
                data[x.hkey] = flatten({...x, ...res[x.hkey]}, {delimiter: "_"})
                Object.keys(data[x.hkey]).forEach(h => {
                    if (headers.indexOf(h) === -1) headers.push(h)
                })
            })
            let out = []
            out.push(headers)            
            hkeys.forEach(x => {
                let rec = []
                if (x in data) {
                    headers.forEach(h => rec.push(data[x][h]))
                } else {
                    headers.forEach(h => rec.push((h === 'hkey') ? x : null))
                }
                out.push(rec)
            })   
            var buffer = xlsx.build([{name: "report", data: out}])
            resp.set('Content-Type', 'application/octet-stream')
            resp.attachment(`Green Stay - Hotel Group Status Report - ${codeData.id}.xlsx`)
            resp.status(200).send(buffer)
        }).catch(err => {
            trackEvent('Audit Web Service', 'Green Audit Group Report Failure', codeData.id)
            logger.logEvent(logger.EventServiceResponse, { "url": req.originalUrl, "status": 500, "error": "Server Error" })
            resp.status(500).json({ error: 'Server Error' })
        })
    })
})

module.exports = router;