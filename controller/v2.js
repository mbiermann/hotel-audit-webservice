const express = require('express')
const router = express.Router()
const report = require('./reports')
const audits = require('./audits')
const CryptoJS = require('crypto-js')
const logger = require('../utils/logger')
const {trackEvent} = require('../service/tracking')
const {combinedAuthMiddleware: combinedAuthMiddleware} = require('../utils/auth-middleware')
const storage = require('../service/storage')
const ejs = require('ejs')
const fs = require('fs')

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