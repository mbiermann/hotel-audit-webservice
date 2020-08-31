const BadRequestError = require('../model/error/bad-request')
const UnauthorizedError = require('../model/error/unauthorized')
const blocker = require('../utils/blocked-middleware')
const logger = require('../utils/logger')
const {trackEvent} = require('../service/tracking')

const _configuredSecretKey = process.env.SECRET_KEY || 'big-secret';

const validate = request => {
    return new Promise((resolve, reject) => {

        let secretKey = null

        switch (request.method) {
            case 'GET':
                secretKey = request.query['secretKey']
                break
            default:
                secretKey = request.body['secretKey']
        }

        if (!secretKey) 
            return reject({
                error: new UnauthorizedError('Missing secret key'), 
                providedKey: secretKey
            })
    
        if (_configuredSecretKey !== secretKey) 
            return reject({
                error: new UnauthorizedError('Provided secret key does not match'), 
                providedKey: secretKey
            })

        resolve()

    })
}

module.exports = {
    validate: validate,
    middleware: (req, res, next) => {
        validate(req).then(next).catch( reason => {
            blocker.block(req, (ip) => {
                trackEvent('Audit Web Service', 'Incorrect secret key', JSON.stringify({key_provided: reason.providedKey, ip: ip}))
                logger.logEvent(logger.EventSecretKeyError, {error: reason.error.message, key_provided: reason.providedKey, ip: ip})
                res.status(403).json({error: 'Incorrect authentication.'})
            })
        })
    }
}