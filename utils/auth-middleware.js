const BadRequestError = require('../model/error/bad-request')
const UnauthorizedError = require('../model/error/unauthorized')
const blocker = require('../utils/blocked-middleware')
const logger = require('../utils/logger')
const {trackEvent} = require('../service/tracking')
const {validate: validateCitrixAccess} = require('../utils/citrix-access')
const {validate: validateJWTAccess} = require('../utils/jwt-auth')
const {validate: validateRateLimitedAccess} = require('../utils/rate-limiter-middleware')
const any = require('promise.any')

const combinedAuthMiddleware = (req, res, next) => {
    any([validateCitrixAccess(req), validateJWTAccess(req), validateRateLimitedAccess(req)]).then(next).catch(err => {
        trackEvent('Audit Web Service', 'Authentication error', "No authentication successful")
        logger.logEvent(logger.EventServiceResponse, { "url": req.originalUrl, "status": 401, "error": "Authentication Error", trace: "No authentication successful" })
        blocker.block(req, (timeout) => {
            res.status(401).json({
                error: true,
                message: `Unauthorized access. You're blocked from this service for ${timeout} seconds.`
            })
        })      
    })
}

module.exports = {
    combinedAuthMiddleware: combinedAuthMiddleware
}