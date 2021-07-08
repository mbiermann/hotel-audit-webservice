const redis = require('redis')
const {RateLimiterRedis} = require('rate-limiter-flexible')
const storage = require('../service/storage')

const redisClient = redis.createClient({
  host: process.env.REDIS_HOST,
  port: 6379,
  enable_offline_queue: false,
})

const _validateRateLimitAccess = (req, settings) => {
    return new Promise((resolve, reject) => {
        //console.log("Validate request for", req.originalUrl)
        var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress
        ip = ip.split(",")[0]
        //console.log("IP is", ip, "with settings", JSON.stringify(settings))
        const rateLimiter = new RateLimiterRedis({
            storeClient: redisClient,
            keyPrefix: 'rate-limiter',
            points: settings.rate_limit_max, 
            duration: settings.rate_limit_window
        })
        return rateLimiter.consume(ip).then((rate) => {
            //console.log(settings.grants, new RegExp(settings.grants))
            if ((settings.grants === 'general_access') || req.originalUrl.match(new RegExp(settings.grants))) resolve()
            reject(new Error("Path not allowed"))            
        }).catch(err => {
            reject(new Error(`Too many requests from IP ${ip} with count ${err.consumedPoints} but allowed only ${settings.rate_limit_max}`))
        })
    })
}

let validate = (req) => {
    const clientID = req.body.client_id || req.query.client_id || req.headers['x-client_id']
    //console.log("Client ID", clientID)
    if (clientID) {
        //console.log("Get settings from storage", clientID)
        return storage.getCachedClientSettings(clientID).then(settings => {
            //console.log("Client Settings", settings)
            if (null === settings) {
                return storage.getClientSettingsFromDB(clientID).then(dbSettings => {
                    //console.log("Client DB Settings", dbSettings)
                    if (null === dbSettings) throw new Error("No rate-limited client settings found")
                    //console.log("Client DB Settings to cache", dbSettings)
                    storage.cacheClientSettings(clientID, dbSettings)
                    //console.log("Now vaidate request")
                    return _validateRateLimitAccess(req, dbSettings)
                })
            } else {
                return _validateRateLimitAccess(req, settings)
            }
        })
    } else {
        next()
    }
}

module.exports = {
    validate: validate
}
