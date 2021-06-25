const express = require('express')
const router = express.Router()
const storage = require('../service/storage')
const { trackEvent } = require('../service/tracking')
const { combinedAuthMiddleware: combinedAuthMiddleware } = require('../utils/auth-middleware')
const blocker = require('../utils/blocked-middleware')

router.get('/:id', combinedAuthMiddleware, async (req, resp) => {
    storage.getCheckinConfigByID(req.params.id).then(res => {
        resp.status(200).json(res)
    }).catch(err => {
        trackEvent('Audit Web Service', 'Clean & Safe Check-in Config Request Failure', req.query.hkeys)
        logger.logEvent(logger.EventServiceResponse, { "url": req.originalUrl, "status": 500, "error": "Server Error" })
        resp.status(500).json({ error: 'Server Error' })
    })
})

module.exports = router