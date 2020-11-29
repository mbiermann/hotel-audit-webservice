const express = require('express')
const router = express.Router()
const storage = require('../service/storage')
const logger = require('../utils/logger')
const { trackEvent } = require('../service/tracking')
const { middleware: authMiddleware } = require('../utils/auth-middleware')
const {middleware: citrixAccess} = require('../utils/citrix-access')
const blocker = require('../utils/blocked-middleware')
const { Logging } = require('@google-cloud/logging')
const Excel = require('exceljs')

let projectId = process.env.GC_PROJECT_ID
const logging = new Logging({ projectId });
const logName = process.env.GC_FETCHLOG
const auditFetchLog = logging.log(logName);

router.get('/report', authMiddleware('normal'), async (req, resp) => {
    
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

router.get('/report/touchlessstay', authMiddleware('normal'), async (req, resp) => {
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

router.get('/report/cleanandsafe_sgs_inspections_completed', citrixAccess, (req, res) => {
    storage.getCompletedSGSAudits().then(async (data) => {
        let workbook = new Excel.stream.xlsx.WorkbookWriter()
        let worksheet = workbook.addWorksheet('SGS Inspections Completed')
        worksheet.columns = [{header: 'HKey', key: 'hkey'},{header: 'Audit ID', key: 'audit_id'},{header: 'Date', key: 'date'}]
        data.forEach((e, index) => { worksheet.addRow({...e}).commit() })
        worksheet.commit()
        await workbook.commit()
        let stream = workbook.stream.read()
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        res.setHeader('Content-Disposition', `attachment; filename=cleanandsafe_sgs_inspections_completed.xlsx`)
        res.setHeader('Content-Length', stream.length)
        res.send(stream)
    })
})

router.get('/', async (req, resp) => {

    let startDate = new Date()
    
    let hkeys = []
    if (!!req.query && !!req.query.hkeys) hkeys = req.query.hkeys.split(',')

    let touchless = storage.getTouchlessStatusForHkeys(hkeys)
    let cleansafe = storage.getAuditRecordsForHkeys(hkeys, ('bypass_cache' in req.query))
    let green = storage.getGreenAuditRecordsForHkeys(hkeys) /* TODO: Add Caching */

    Promise.all([touchless, cleansafe, green]).then(async (result) => {
        let _touchless = result[0]
        let _cleansafe = result[1]
        let _green = result[2]

        let data = {}
        let csTouchlessCheckin = new Set()
        
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

        for (let hkey of hkeys) {
            if (csTouchlessCheckin.has(hkey) || _touchless.indexOf(Number(hkey)) > -1) {
                if (!(hkey in data)) data[hkey] = []
                data[hkey].push({
                    type: 'touchless_stay',
                    status: true
                })
            }
            if (hkey in _green) {
                if (!(hkey in data)) data[hkey] = []
                let record = _green[hkey]
                delete record.hkey
                data[hkey].push(record)
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
        trackEvent('Audit Web Service', 'Audits Request Failure', req.query.hkeys)
        logger.logEvent(logger.EventServiceResponse, { "url": req.originalUrl, "status": 500, "error": "Server Error" })
        resp.status(500).json({ error: 'Server Error' })
    })  
    
})

router.get('/green/reports/:id', authMiddleware('normal'), async (req, resp) => {
    storage.getGreenAuditForReportId(req.params.id).then(res => {
        resp.status(200).json(res)
    }).catch(err => {
        trackEvent('Audit Web Service', 'Green Audit Request Failure', req.query.hkeys)
        logger.logEvent(logger.EventServiceResponse, { "url": req.originalUrl, "status": 500, "error": "Server Error" })
        resp.status(500).json({ error: 'Server Error' })
    })
})

module.exports = router;