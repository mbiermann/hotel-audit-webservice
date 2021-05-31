const cache = require('../client/cache')
const logger = require('../utils/logger')
const {trackEvent} = require('../service/tracking')

let middleware = (req, res, next) => {
    let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress
    ip = ip.split(",")[0]
    cache.get(`block:${req.headers.host}:${ip}`, (err, reply) => {
        if (reply) {
            block(req, (timeout) => {
                trackEvent('Audit Web Service', 'Blocked Access', {ip: ip, timeout: timeout})
                logger.logEvent(logger.EventBlockedAccessError, {ip: ip, timeout: timeout})
                return res.status(403).json({error: true, message: `You're blocked now for ${timeout} seconds from this service`})
            })
        } else {
            next()
        }
    })
}

let block = (req, handler) => {
    let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress
    ip = ip.split(",")[0]
    let timeout = 10
    cache.get(`block:${req.headers.host}:${ip}`, (err, reply) => {
        reply = JSON.parse(reply)
        if (reply) {
            timeout = reply.timeout * 2
        }
        cache.set(`block:${req.headers.host}:${ip}`, JSON.stringify({block: ip, timeout: timeout}), 'EX', timeout);
        logger.logEvent(logger.EventBlockError, {ip: ip, timeout: timeout})
        trackEvent('Audit Web Service', 'Blocked IP', {ip: ip, timeout: timeout})
        handler(timeout)
    })
}

module.exports = {
    middleware: middleware,
    block: block
}