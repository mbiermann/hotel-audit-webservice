let select = (fields, obj) => {
    return fields.reduce((o,k) => {o[k] = obj[k]; return o;}, {})
}

class GreenStayAuditRecord {
    constructor(auditData) {
        this.hkey = auditData.hkey
        this.id = auditData._id
        this.created_date = auditData._createdDate
        this.updated_date = auditData._updatedDate
        this.report_year = auditData.report_year
        this.kilogramCarbonPOC = auditData.kgCo2ePOC
        this.literWaterPOC = auditData.lH2OPOC
        this.kilogramWastePOC = auditData.kgWastePOC
        this.carbonClass = auditData.carbonClass
        this.waterClass = auditData.waterClass
        this.wasteClass = auditData.wasteClass
        this.greenClass = auditData.greenClass
        if (auditData.confidence) this.confidence = auditData.confidence
        if (auditData.status === undefined) {
            if (auditData.anomalies && auditData.anomalies.length > 0) {
                this.anomalies = auditData.anomalies
                this.type = "green_stay_blocked_anomaly"
                this.status = false
            } else {
                this.type = "green_stay_self_inspection"
                if (["A","B"].indexOf(auditData.greenClass) > -1) this.type = `${this.type}_hero`
                this.status = true
            }
        } else {
            this.type = auditData.type
            this.status = auditData.status
        }

        this.chain_id = auditData.chain_id
        this.compensation = !!auditData.compensation

        // GSI1
        if (auditData.program) this.program = select(['name', 'link'], auditData.program)
        if (auditData.cert) this.cert = select(['cert_id', 'validity_start', 'validity_end', 'url', 'issuer'], auditData.cert)
        // GSI2
        if (auditData.programs) this.programs = auditData.programs.map(x => select(['name', 'link'], x))
        if (auditData.certs) this.certs = auditData.certs.map(x => select(['cert_id', 'validity_start', 'validity_end', 'url', 'issuer'], x))
    }
}

module.exports = {
    GreenStayAuditRecord: GreenStayAuditRecord
}