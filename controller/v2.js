const express = require('express')
const router = express.Router()
const report = require('./reports')
const audits = require('./audits')
const check_ins = require('./check-ins')
const magic_login = require('./magic-login')
const CryptoJS = require('crypto-js')
const logger = require('../utils/logger')
const {trackEvent} = require('../service/tracking')
const {combinedAuthMiddleware: combinedAuthMiddleware} = require('../utils/auth-middleware')
const storage = require('../service/storage')
const ejs = require('ejs')
const fs = require('fs')

router.use('/audits', audits)
router.use('/check-ins', check_ins)
router.use('/magic-login', magic_login)

router.get('/hotel-status', combinedAuthMiddleware, (req, resp) => {
    if (!req.query || !req.query.hkeys) return resp.status(500).json({ error: 'Missing hkeys' })
    const hkeys = req.query.hkeys.split(',').map((val) => Number(val))
    
    console.log((req.query.backfill == "true"))
    storage.getHotelStatusByHkeys(hkeys, {green: true, clean: true}, false, true, ("true" == req.query.backfill)).then(statuses => {
        resp.send(statuses)
    }).catch((err) => {
        console.log(err)
        logger.logEvent(logger.EventServiceResponse, {"url": req.originalUrl, "status": 500, "error": "Server Error"})
        resp.status(500).json({ error: 'Server Error' })
    })
    
})

router.get('/invitations/hotels', combinedAuthMiddleware, (req, resp) => {
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
        let kgCO2ePOC = Math.round(res.kilogramCarbonPOC*100)/100
        let lWaterPOC = Math.round(res.literWaterPOC)
        let kgWastePOC = (res.kilogramWastePOC === -1) ? "N/A" : Math.round(res.kilogramWastePOC*1000)/1000
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
        resp.redirect(`https://www.hrs.com/enterprise/en/integrations/green-stay?utm_source=hotel_om&utm_medium=gs_hotel_${type}_widget_${req.params.type}&utm_campaign=greenstay&utm_content=${res.hkey}`)
    }).catch(err => {
        trackEvent('Audit Web Service', 'Green Stay Widget Link Request Failure', 'audit_id::'+dec)
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

module.exports = router;