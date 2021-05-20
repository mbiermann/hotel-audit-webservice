class Logger {

    constructor() {
        this.EventAuditCacheHit = "AuditCacheHit"
        this.EventAuditCacheMiss = "AuditCacheMiss"
        this.EventAuditCacheError = "AuditCacheError"
        this.EventAuditDatabaseHit = "AuditDBHit"
        this.EventAuditDatabaseMiss = "AuditDBMiss"
        this.EventAuditDatabaseError = "AuditDBError"
        this.EventAuditDatabaseQueryError = "AuditDBQueryError"
        this.EventAuditCacheError = "AuditCacheError"
        this.EventURLShortenError = "URLShortenError"
        this.EventServiceResponse = "ServiceResponse",
        this.ReportError = "ReportError",
        this.EventSecretKeyError = "EventSecretKeyError",
        this.EventBlockedAccessError = "EventBlockedAccessError",
        this.ReportRunStatusUpdate = "ReportRunStatusUpdate"
    }

    logEvent(event, value) {
        console.log(`{"event":"${event}", "service": "${process.env.service_name}", "data": ${JSON.stringify(value)}}`)
    }
}

module.exports = new Logger()