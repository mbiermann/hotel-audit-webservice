const cache = require('../client/cache')
const logger = require('../utils/logger')
const {trackEvent} = require('../service/tracking')

let _ipFromReq = (req) => {
    let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress
    ip = ip.split(",")[0]
    return ip
}

let middleware = (req, res, next) => {
    next()
}

let block = (req, handler) => {
    let ip = _ipFromReq(req)
    let timeout = 10
    cache.get(`block:${req.headers.host}:${ip}`, (err, reply) => {
        reply = JSON.parse(reply)
        if (reply) {
            timeout = reply.timeout + timeout
        }
        cache.set(`block:${req.headers.host}:${ip}`, JSON.stringify({block: ip, timeout: timeout}), 'EX', timeout);
        logger.logEvent(logger.EventBlockError, {ip: ip, timeout: timeout})
        trackEvent('Audit Web Service', 'Blocked IP', {ip: ip, timeout: timeout})
        handler(timeout)
    })
}

let isBlocked = (req) => {
    return new Promise((resolve, reject) => {
        let ip = _ipFromReq(req)
        cache.get(`block:${req.headers.host}:${ip}`, (err, reply) => {
            resolve(!!reply)
        })
    })
}

let unblock = (req, handler) => {
    isBlocked(req).then(_isBlocked => {
        if (_isBlocked) {
            let ip = _ipFromReq(req)
            cache.del(`block:${req.headers.host}:${ip}`, (err) => {
                logger.logEvent(logger.EventUnblock, {ip: ip})
                trackEvent('Audit Web Service', 'Unblocked IP', {ip: ip})
                handler()
            })
        } else {
            handler()
        }
    })
}

module.exports = {
    block: block,
    unblock: unblock
}