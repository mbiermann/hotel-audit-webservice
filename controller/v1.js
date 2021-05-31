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

router.use('/reports', report)
router.use('/audits', audits)

router.get('/hotel-status', combinedAuthMiddleware, (req, resp) => {
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

/**
 * Gets sample set of hotels representing top portfolio regions for use by Hotel Audit Portal 
 * in auditing a chain's internal emission factors to comply with Green Stay database.
 */
router.get('/chains/:id/sample-hotels', combinedAuthMiddleware, (req, resp) => {
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

module.exports = router;