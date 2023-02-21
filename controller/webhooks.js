const express = require('express')
const router = express.Router()
const webhook = require('../service/webhook')
const { combinedAuthMiddleware: combinedAuthMiddleware } = require('../utils/auth-middleware')

router.get('/', combinedAuthMiddleware, webhook.getWebhooks)

router.post('/', combinedAuthMiddleware, webhook.createWebhook)

router.delete('/:id', combinedAuthMiddleware, webhook.deleteWebhook)

module.exports = router;