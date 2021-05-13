const express = require('express')
const router = express.Router()
const report = require('./reports')
const audits = require('./audits')
const CryptoJS = require('crypto-js')
const logger = require('../utils/logger')
const {trackEvent} = require('../service/tracking')
const {validate: validateCitrixAccess} = require('../utils/citrix-access')
const {validate: validateSecretAccess, middleware: authMiddleware} = require('../utils/auth-middleware')
const storage = require('../service/storage')
const ejs = require('ejs')
const any = require('promise.any')
const fs = require('fs')

router.use('/reports', report)
router.use('/audits', audits)

const authHotelStatusAccess = (req, res, next) => {
    any([validateCitrixAccess(req), validateSecretAccess(req)]).then(next).catch(err => {
        res.status(401).send()
    })
}

router.get('/hotel-status', authHotelStatusAccess, (req, resp) => {
    
    if (!req.query || !req.query.hkeys) return resp.status(500).json({ error: 'Missing hkeys' })
    const hkeys = req.query.hkeys.split(',').map((val) => Number(val))
    
    storage.getHotelStatusByHkeys(hkeys, {green: true, clean: true} ,false, true).then(statuses => {
        resp.send(statuses)
    }).catch((err) => {
        console.log(err)
        logger.logEvent(logger.EventServiceResponse, {"url": req.originalUrl, "status": 500, "error": "Server Error"})
        resp.status(500).json({ error: 'Server Error' })
    })
    
})

router.get('/chains/:id', authHotelStatusAccess, (req, resp) => {
    if (!req.params.id) return resp.status(500).json({ error: 'Missing chain ID' })
    storage.getChainStatus(req.params.id).then(status => {
        if (!status) return resp.status(401).json({error: `No chain with ID ${req.params.id} available.`})
        resp.send({
            id: status.id,
            name: status.name,
            invitation_link: `https://www.hotel-audit.hrs.com/group-assessment/${status.id}/${status.invitation_code}`
        })
    }).catch((err) => {
        logger.logEvent(logger.EventServiceResponse, {"url": req.originalUrl, "status": 500, "error": "Server Error"})
        resp.status(500).json({ error: 'Server Error' })
    })
})

/**
 * Gets sample set of hotels representing top portfolio regions for use by Hotel Audit Portal 
 * in auditing a chain's internal emission factors to comply with Green Stay database.
 */
router.get('/chains/:id/sample-hotels', authHotelStatusAccess, (req, resp) => {
    if (!req.params.id) return resp.status(500).json({ error: 'Missing chain ID' })
    storage.getChainSampleHotels(req.params.id).then(res => {
        if (!res) return resp.status(401).json({error: `No chain with ID ${req.params.id} available.`})
        resp.send(res)
    }).catch((err) => {
        logger.logEvent(logger.EventServiceResponse, {"url": req.originalUrl, "status": 500, "error": "Server Error", trace: JSON.stringify(err)})
        resp.status(500).json({ error: 'Server Error' })
    })
})

router.get('/cs_cert/:code', (req, resp) => {
    if (!("code" in req.params)) return resp.sendStatus(403)
    let bytes = null
    let dec = null
    try {
        bytes = CryptoJS.AES.decrypt(CryptoJS.enc.Hex.parse(req.params.code).toString(CryptoJS.enc.Base64), process.env.CERT_PASS)
        dec = bytes.toString(CryptoJS.enc.Utf8)
    } catch (err) {
        return resp.sendStatus(403)
    }
    if (dec.length === 0) return resp.sendStatus(403)
    storage.getSGSAuditById(dec).then(res => {
        let name = res.name
        let address = res.city + ", " + res.country
        let id = res.audit_id
        ejs.renderFile(process.cwd() + "/cert.html", {name:name, address:address, id:id}, {}, function(err, str){
            if (err) return resp.sendStatus(500)
            trackEvent('Audit Web Service', 'Cert Request Success', 'audit_id::'+dec+'::'+id)
            resp.status(200).send(str)
        })
    }).catch(err => {
        trackEvent('Audit Web Service', 'Cert Request Failure', 'audit_id::'+dec)
        return resp.sendStatus(500)
    })
})

router.get('/gs_cert/:code', (req, resp) => {
    if (!("code" in req.params)) return resp.sendStatus(403)
    let bytes = null
    let dec = null
    try {
        bytes = CryptoJS.AES.decrypt(CryptoJS.enc.Hex.parse(req.params.code).toString(CryptoJS.enc.Base64), process.env.CERT_PASS)
        dec = bytes.toString(CryptoJS.enc.Utf8)
    } catch (err) {
        return resp.sendStatus(403)
    }
    if (dec.length === 0) return resp.sendStatus(403)
    storage.getGreenAuditForReportId(dec).then(async res => {
        let hotel = await storage.getHotelByHKey(res.hkey)
        let name = hotel.name
        let address = hotel.city + ", " + hotel.country
        let id = res.id
        let year = res.report_year
        let kgCO2ePOC = Math.round(res.kilogramCarbonPOC)
        let lWaterPOC = Math.round(res.literWaterPOC)
        let kgWastePOC = Math.round(res.kilogramWastePOC*100)/100
        const data = {name:name, address:address, id:id, year:year, kgCO2ePOC: kgCO2ePOC, lWaterPOC: lWaterPOC, kgWastePOC:kgWastePOC}
        const template = (res.greenClass === "A") ? "/gs_award.html" : "/gs_cert.html"
        ejs.renderFile(process.cwd() + template, data, {}, function(err, str){
            if (err) return resp.sendStatus(500)
            trackEvent('Audit Web Service', 'Green Stay Cert Request Success', 'audit_id::'+dec+'::'+id)
            resp.status(200).send(str)
        })
    }).catch(err => {
        trackEvent('Audit Web Service', 'Green Stay Cert Request Failure', 'audit_id::'+dec)
        return resp.sendStatus(500)
    })
})

router.get('/cs_widget/:type/:code', (req, resp) => {
    if (!("code" in req.params)) return resp.sendStatus(403)
    let bytes = null
    let dec = null
    try {
        bytes = CryptoJS.AES.decrypt(CryptoJS.enc.Hex.parse(req.params.code).toString(CryptoJS.enc.Base64), process.env.CERT_PASS)
        dec = bytes.toString(CryptoJS.enc.Utf8)
    } catch (err) {
        return resp.sendStatus(403)
    }
    if (dec.length === 0) return resp.sendStatus(403)
    storage.getSGSAuditById(dec).then(res => {
        var img = fs.readFileSync(process.cwd() + (req.params.type === 'badge' ? '/badge.png' : '/widget.png'))
        resp.writeHead(200, {'Content-Type': 'image/png' })
        resp.end(img, 'binary');
    }).catch(err => {
        trackEvent('Audit Web Service', 'Widget Request Failure', 'audit_id::'+dec)
        return resp.sendStatus(500)
    })
})

router.get('/cs_widget_link/:type/:code', (req, resp) => {
    if (!("code" in req.params)) return resp.sendStatus(403)
    let bytes = null
    let dec = null
    try {
        bytes = CryptoJS.AES.decrypt(CryptoJS.enc.Hex.parse(req.params.code).toString(CryptoJS.enc.Base64), process.env.CERT_PASS)
        dec = bytes.toString(CryptoJS.enc.Utf8)
    } catch (err) {
        return resp.sendStatus(403)
    }
    if (dec.length === 0) return resp.sendStatus(403)
    storage.getSGSAuditById(dec).then(res => {
        resp.redirect(`https://hotel-audit.hrs.com/clean-and-safe?utm_source=hotel_om&utm_medium=cs_hotel_expert_widget_${req.params.type}&utm_campaign=cleansafe&utm_content=${res.hkey}`)
    }).catch(err => {
        trackEvent('Audit Web Service', 'Widget Link Request Failure', 'audit_id::'+dec)
        return resp.sendStatus(500)
    })
})

router.get('/gs_widget/:type/:code', (req, resp) => {
    if (!("code" in req.params)) return resp.sendStatus(403)
    let bytes = null
    let dec = null
    try {
        bytes = CryptoJS.AES.decrypt(CryptoJS.enc.Hex.parse(req.params.code).toString(CryptoJS.enc.Base64), process.env.CERT_PASS)
        dec = bytes.toString(CryptoJS.enc.Utf8)
    } catch (err) {
        return resp.sendStatus(403)
    }
    if (dec.length === 0) return resp.sendStatus(403)
    storage.getGreenAuditForReportId(dec).then(async res => {
        let type = 'basic'
        var img = fs.readFileSync(process.cwd() + (req.params.type === 'badge' ? `/gs_badge_${type}.png` : `/gs_widget_${type}.png`))
        resp.writeHead(200, {'Content-Type': 'image/png' })
        resp.end(img, 'binary');
    }).catch(err => {
        trackEvent('Audit Web Service', 'Green Stay Widget Request Failure', 'report_id::'+dec)
        return resp.sendStatus(500)
    })
})

router.get('/gs_widget_link/:type/:code', (req, resp) => {
    if (!("code" in req.params)) return resp.sendStatus(403)
    let bytes = null
    let dec = null
    try {
        bytes = CryptoJS.AES.decrypt(CryptoJS.enc.Hex.parse(req.params.code).toString(CryptoJS.enc.Base64), process.env.CERT_PASS)
        dec = bytes.toString(CryptoJS.enc.Utf8)
    } catch (err) {
        return resp.sendStatus(403)
    }
    if (dec.length === 0) return resp.sendStatus(403)
    storage.getGreenAuditForReportId(dec).then(async res => {
        let type = 'basic'
        resp.redirect(`https://hotel-audit.hrs.com/clean-and-safe?utm_source=hotel_om&utm_medium=gs_hotel_${type}_widget_${req.params.type}&utm_campaign=greenstay&utm_content=${res.hkey}`)
    }).catch(err => {
        trackEvent('Audit Web Service', 'Green Stay Widget Link Request Failure', 'audit_id::'+dec)
        return resp.sendStatus(500)
    })
})

router.get('/cs_sticker/:type/:code', (req, resp) => {
    if (!("code" in req.params)) return resp.sendStatus(403)
    let bytes = null
    let dec = null
    try {
        bytes = CryptoJS.AES.decrypt(CryptoJS.enc.Hex.parse(req.params.code).toString(CryptoJS.enc.Base64), process.env.CERT_PASS)
        dec = bytes.toString(CryptoJS.enc.Utf8)
    } catch (err) {
        return resp.sendStatus(403)
    }
    if (dec.length === 0) return resp.sendStatus(403)
    storage.getSGSAuditById(dec).then(res => {
        var pdf = fs.readFileSync(process.cwd() + (req.params.type === 'round' ? '/sticker_round.pdf' : '/sticker_rect.pdf'))
        resp.contentType('application/pdf')
        resp.send(pdf);
    }).catch(err => {
        trackEvent('Audit Web Service', 'Sticker Request Failure', 'audit_id::'+dec)
        return resp.sendStatus(500)
    })
})

router.get('/gs_sticker/:type/:code', (req, resp) => {
    if (!("code" in req.params)) return resp.sendStatus(403)
    let bytes = null
    let dec = null
    try {
        bytes = CryptoJS.AES.decrypt(CryptoJS.enc.Hex.parse(req.params.code).toString(CryptoJS.enc.Base64), process.env.CERT_PASS)
        dec = bytes.toString(CryptoJS.enc.Utf8)
    } catch (err) {
        return resp.sendStatus(403)
    }
    if (dec.length === 0) return resp.sendStatus(403)
    storage.getGreenAuditForReportId(dec).then(async res => {
        let type = 'basic'
        var pdf = fs.readFileSync(process.cwd() + (req.params.type === 'round' ? `/gs_sticker_round.pdf` : `/gs_sticker_rect_${type}.pdf`))
        resp.contentType('application/pdf')
        resp.send(pdf);
    }).catch(err => {
        trackEvent('Audit Web Service', 'Green Stay Sticker Request Failure', 'audit_id::'+dec)
        return resp.sendStatus(500)
    })
})

router.get('/invitations/hotels', authMiddleware('invitations'), (req, resp) => {
    if (!!req.query && !!req.query.page && !!req.query.size) {
        let page = Number(req.query.page)
        if (isNaN(page) || page === 0) page = 1
        let size = Number(req.query.size)
        if (isNaN(size)) size = 10
        if (size > 500) size = 500
        let offset = (page > 1 ? (page - 1) * size : 0)
        storage.getInvitations(offset, size).then(res => {
            resp.status(200).json({ results: res.result, page_number: page, page_size: size, total_pages: Math.ceil(res.total / size) });
        }).catch(err => {
            trackEvent('Audit Web Service', 'Get Hotel Invitations Failure')
            return resp.sendStatus(500)
        })     
    } else {
        resp.sendStatus(403)
    }
})

module.exports = router;