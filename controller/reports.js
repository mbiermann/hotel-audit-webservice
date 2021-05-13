const express = require('express')
const router = express.Router()
const logger = require('../utils/logger')
const {trackEvent} = require('../service/tracking')
const storage = require('../service/storage')
const {middleware: citrixAccess} = require('../utils/citrix-access')
const {createReport} = require('../service/report')

if (process.env.MODE === 'REPORT') {
    router.patch('/hs-report', async (_, resp) => {
        resp.status(200).send()
        let filePath = await createReport('clean')
        await storage.uploadFile(filePath)
        trackEvent('Audit Web Service', 'HS Report Created')
    })
}

router.get('/green-report', async (_, resp) => {
    resp.status(200).send()
    let filePath = await createReport('green')
    console.log("Upload Zip", filePath)
    await storage.uploadFile(filePath)
    trackEvent('Audit Web Service', 'Green Report Created')
})


router.get('/hs-report', citrixAccess, (_, res) => {
    res.setHeader('Content-Disposition', 'attachment;filename=hs-report.zip')
    storage.readFileStream('out.csv.zip').pipe(res)
})

router.get('/clients', citrixAccess, (req, res) => {
    storage.getClients(req.params.search).then(data => {
        res.status(200).json(data)
    })
})

router.get('/clients/:id/audits', citrixAccess, (req, res) => {
    storage.getClientDataForId(req.params.id).then(async data => {
        let rfps = {}
        for (let item of data) {
            if (!(item.name in rfps)) rfps[item.name] = []
            rfps[item.name].push(item.hkey) 
        }
        let proms = []
        let total_hkeys = []
        for (let [key, hkeys] of Object.entries(rfps)) {
            for (let hkey of hkeys) if (total_hkeys.indexOf(hkey) === -1) total_hkeys.push(hkey)
            proms.push(new Promise((resolve, reject) => {
                return storage.getAuditRecordsForHkeys(hkeys).then((audits) => {
                    let stats = {num_hotels: hkeys.length, audits: {}}
                    for (let hkey of Object.keys(audits)) {
                        for (let elem of audits[hkey]) {
                            if (!(elem.type in stats.audits)) stats.audits[elem.type] = { successful: 0, failed: 0}
                            stats.audits[elem.type][elem.status ? 'successful' : 'failed'] += 1
                        }
                    }
                    resolve({rfp: key, stats: stats})
                })
            }))
        }
        return Promise.all(proms).then(results => {
            trackEvent('Audit Web Service', 'Clients Report Success', req.params.id)
            logger.logEvent(logger.EventServiceResponse, {"url": req.originalUrl, "status": 200})
            let totals = {num_hotels: total_hkeys.length, audits: {}} 
            for (let result of results) {
                if (!('stats' in result) || !('audits' in result.stats)) continue
                for (let [key, val] of Object.entries(result.stats.audits)) {
                    if (!totals.audits[key]) totals.audits[key] = {successful: 0, failed: 0}
                    for (let [k, v] of Object.entries(result.stats.audits[key])) totals.audits[key][k] += v
                }
            }
            res.status(200).json({summary: totals, rfps: results})
        })        
    }).catch(err => {
        trackEvent('Audit Web Service', 'Clients Report Failure', req.params.id)
        logger.logEvent(logger.EventServiceResponse, {"url": req.originalUrl, "status": 500, "error": "Server Error"})
        res.status(500).json({ error: 'Server Error' })
    })
})

module.exports = router;