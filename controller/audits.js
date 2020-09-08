const express = require('express')
const router = express.Router()
const storage = require('../service/storage')
const logger = require('../utils/logger')
const { trackEvent } = require('../service/tracking')
const { middleware: authMiddleware } = require('../utils/auth-middleware')
const blocker = require('../utils/blocked-middleware')
const { Logging } = require('@google-cloud/logging')

let projectId = process.env.GC_PROJECT_ID
const logging = new Logging({ projectId });
const logName = process.env.GC_FETCHLOG
const auditFetchLog = logging.log(logName);

router.get('/report', authMiddleware, async (req, resp) => {
    
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
            resp.status(403).json({ results: res.result, page_number: page, page_size: size, total_pages: Math.ceil(res.total / size) });
        })
    } else {
        resp.sendStatus(403)
    }

})

router.get('/', async (req, resp) => {

    let startDate = new Date()
    /*let isTrustedClient = false
    if (!!req.query && ('secretKey' in req.query)) {
        const configuredSecretKey = process.env.SECRET_KEY || 'big-secret';
        switch (req.query.secretKey) {
            case configuredSecretKey:
                isTrustedClient = true
                break
            default:
                return blocker.block(req, (ip) => {
                    trackEvent('Audit Web Service', 'Incorrect secret key on audits/ endpoint', JSON.stringify({key_provided: req.query.secretKey, ip: ip}))
                    logger.logEvent(logger.EventSecretKeyError, {error: 'Incorrect secret key on audits/ endpoint', key_provided: req.query.secretKey, ip: ip})
                    resp.status(403).json({error: 'Incorrect authentication.'})
                })
        }
    }
    */

    let hkeys = []
    if (!!req.query && !!req.query.hkeys) {
        hkeys = req.query.hkeys.split(',')
        /*if (hkeys.length > (isTrustedClient ? 200 : 20)) {
            return blocker.block(req, (ip) => {
                trackEvent('Audit Web Service', 'Too many hkeys on audits/ endpoint', JSON.stringify({num_hkeys: hkeys.length, ip: ip}))
                logger.logEvent(logger.EventSecretKeyError, {error: 'Too many hkeys on audits/ endpoint', num_hkeys: hkeys.length, ip: ip})
                resp.status(403).json({error: 'Too many hkeys.'})
            })
        }*/
    }

    storage.getAuditRecordsForHkeys(hkeys, ('bypass_cache' in req.query)).then(async (res) => {
        let data = {}
        const defaultKeys = ['auditor_key', 'audit_date', 'program_name', 'link']
        for (let hkey of Object.keys(res)) {
            for (let elem of res[hkey]) {
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
        console.log(err)
        trackEvent('Audit Web Service', 'Audits Request Failure', req.query.hkeys)
        logger.logEvent(logger.EventServiceResponse, { "url": req.originalUrl, "status": 500, "error": "Server Error" })
        resp.status(500).json({ error: 'Server Error' })
    })  
    
})

module.exports = router;