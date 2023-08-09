const express = require('express')
const router = express.Router()
const logger = require('../utils/logger')
const {trackEvent} = require('../service/tracking')
const storage = require('../service/storage')
const { combinedAuthMiddleware: combinedAuthMiddleware } = require('../utils/auth-middleware')
const {createReport} = require('../service/report')

if (process.env.MODE === 'REPORT') {
    const generateReport = async (type, label) => {
        const filePath = await createReport(type);
        await storage.uploadFile(filePath);
        trackEvent('Audit Web Service', label + ' Report Created')
    };

    router.patch('/hs-report', async (_, resp) => {
        resp.status(200).send();
        await generateReport('clean', 'HS');
    })

    router.patch('/gsi2-report', async (_, resp) => {
        resp.status(200).send()
        await generateReport('gsi2', 'GSI2');
    })

    router.patch('/green-report', async (_, resp) => {
        resp.status(200).send()
        await generateReport('green', 'GSI1');
    })

    const safeGenerateReport = async (type, label) => {
        try {
            await generateReport(type, label);
        } catch (err) {
            console.warn('Fail to create report ' + label);
        }
    };

    router.patch('/all-report', async (_, resp) => {
        resp.status(200).send()
        await safeGenerateReport('clean', 'HS');
        await safeGenerateReport('gsi2', 'GSI2');
        await safeGenerateReport('green', 'GSI1');
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
    res.setHeader('Content-Disposition', 'attachment;filename=clean-report.zip')
    storage.readFileStream('clean_out_xlsx.zip').pipe(res)
})

module.exports = router;