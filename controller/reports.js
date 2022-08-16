const express = require('express')
const router = express.Router()
const logger = require('../utils/logger')
const {trackEvent} = require('../service/tracking')
const storage = require('../service/storage')
const { combinedAuthMiddleware: combinedAuthMiddleware } = require('../utils/auth-middleware')
const {createReport} = require('../service/report')

if (process.env.MODE === 'REPORT') {
    router.patch('/hs-report', async (_, resp) => {
        resp.status(200).send()
        let filePath = await createReport('clean')
        await storage.uploadFile(filePath)
        trackEvent('Audit Web Service', 'HS Report Created')
    })

    router.patch('/gsi2-report', async (_, resp) => {
        resp.status(200).send()
        let filePath = await createReport('gsi2')
        await storage.uploadFile(filePath)
        trackEvent('Audit Web Service', 'GSI2 Report Created')
    })

    router.patch('/green-report', async (_, resp) => {
        resp.status(200).send()
        let filePath = await createReport('green')
        await storage.uploadFile(filePath)
        trackEvent('Audit Web Service', 'GSI1 Report Created')
    })
}

router.get('/green-report', combinedAuthMiddleware, async (_, resp) => {
    resp.status(200).send()
    let filePath = await createReport('green')
    console.log("Upload Zip", filePath)
    await storage.uploadFile(filePath)
    trackEvent('Audit Web Service', 'Green Report Created')
})


router.get('/hs-report', combinedAuthMiddleware, (_, res) => {
    res.setHeader('Content-Disposition', 'attachment;filename=hs-report.zip')
    storage.readFileStream('clean_out.csv.zip').pipe(res)
})

module.exports = router;