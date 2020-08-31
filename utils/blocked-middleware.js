const cache = require('../client/cache')
const logger = require('../utils/logger')
const {trackEvent} = require('../service/tracking')

module.exports = {
    middleware: (req, res, next) => {
        let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress
        ip = ip.split(",")[0]
        cache.get('block:'+ip, (err, reply) => {
            if (reply) {
                trackEvent('Audit Web Service', 'Blocked Access', ip)
                logger.logEvent(logger.EventBlockedAccessError, ip)
                return res.status(403).json({error: "You're blocked from this service"})
            }
            next()
        })
    },
    block: (req, handler) => {
        let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress
        ip = ip.split(",")[0]
        cache.set('block:'+ip, JSON.stringify({block: ip}), 'EX', process.env.REDIS_TTL);
        logger.logEvent(logger.EventBlockError, ip)
        trackEvent('Audit Web Service', 'Blocked IP', ip)
        handler()
    }
}