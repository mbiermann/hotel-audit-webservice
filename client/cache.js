const redis = require('redis')
const redisScan = require('node-redis-scan');
const logger = require('../utils/logger')

const client = redis.createClient(6379, process.env.REDIS_HOST)

client.on("error", function(error) {
    logger.logEvent(logger.EventAuditCacheError, {"error": error})
});

const scanner = new redisScan(client)
client.scanner = scanner

module.exports = client