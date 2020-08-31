const redis = require('redis')
const logger = require('../utils/logger')

const client = redis.createClient(6379, process.env.REDIS_HOST)

client.on("error", function(error) {
    logger.logEvent(logger.EventAuditCacheError, {"error": error})
});

module.exports = client