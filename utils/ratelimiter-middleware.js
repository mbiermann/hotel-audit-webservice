const redis = require('redis')
const slowDown = require("express-slow-down");
const RedisStore = require('rate-limit-redis');
const logger = require('./logger')
const { measure } = require('measurement-protocol')

function RateLimiter() {
    const rateLimitRedisClient = redis.createClient(6379, process.env.RL_REDIS_HOST)
    rateLimitRedisClient.on("error", (err) => logger.logEvent(logger.RateLimiterRedisError, {error: err}) );
    const rateLimitStore = new RedisStore({client: rateLimitRedisClient})
    
    const speedLimiter = slowDown({
        windowMs: process.env.RL_WINDOW_MINUTES * 60 * 1000, // 15 minutes
        delayAfter: process.env.RL_WINDOW_MAX_REQUESTS, // allow 100 requests per 15 minutes, then...
        delayMs: process.env.RL_DELAY_MILLIS, // begin adding 500ms of delay per request above 100
        maxDelayMs: process.env.RL_MAX_DELAY_MILLIS,
        store: rateLimitStore,
        onLimitReached: (req, res, options) => {
            console.log("Rate limit reached")
            var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress
            ip = ip.split(",")[0]
            measure(process.env.GA_TRACKING_ID).event('Audit Webservice', 'Rate Limit Reached', ip).send()
            logger.logEvent(logger.RateLimiterLimitReached, {ip: req.ip, context: JSON.stringify(options)})
        }
    });
    return speedLimiter
}

module.exports = RateLimiter()