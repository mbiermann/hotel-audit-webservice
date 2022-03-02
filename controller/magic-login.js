const express = require('express')
const router = express.Router()
const storage = require('../service/storage')
const logger = require('../utils/logger')
const { trackEvent } = require('../service/tracking')
const { combinedAuthMiddleware: combinedAuthMiddleware } = require('../utils/auth-middleware')
const blocker = require('../utils/blocked-middleware')
const Validator = require('jsonschema').Validator
const CryptoJS = require('crypto-js')

let createMagicLoginPostBodySchema = {
    id: "/MagicLoginPostBodySchema",
    type: "object",
    properties: {
        type: {
            enum: ["hotel"]
        },
        id: {
            type: ["integer"]
        }
    }
}

let LookupPostBodySchema = {
    id: "/LookupPostBodySchema",
    type: "object",
    properties: {
        email: {
            type: ["string"]
        }
    }
}

class PostBodyValidationError extends Error {
    constructor(message) {
        super(message)
        this.name = "PostBodyValidationError"
    }
}

class MagicLoginExpiredError extends Error {
    constructor(message) {
        super("Link expired.")
        this.name = "MagicLoginExpiredError"
    }
}

router.post('/lookup', combinedAuthMiddleware, async (req, res) => {
    const postData = req.body
    let schemaCheck = new Validator()
    try {
        if (!schemaCheck.validate(postData, LookupPostBodySchema))
            throw new PostBodyValidationError("Invalid POST body.")
        storage.getHotelsForEmail(postData.email).then(items => {
            res.status(200).json({hotels: items.map(x => ({hkey: x.hkey, name: x.name}))})
        })
    } catch (e) {
        switch (e.name) {
            case "PostBodyValidationError": 
                res.status(401).json({error: true, message: `${e.name}: ${e.message}`})
                break
            default:
                console.log(`${e.name}: ${e.message}`)
                res.status(400).json({error: true, message: 'Unauthorized access.'})
        }
    }
})

router.post('/create', combinedAuthMiddleware, async (req, res) => {
    const postData = req.body
    let schemaCheck = new Validator()
    try {
        if (!schemaCheck.validate(postData, createMagicLoginPostBodySchema))
            throw new PostBodyValidationError("Invalid POST body.")
        let hotel = await storage.getHotelByHKey(postData.id)
        let link = `https://hotel-audit.hrs.com/start/access/hotel/${hotel.hkey}/${hotel.code}`
        let i = 0
        for (let key in req.query) {
            if (/^utm_.*/.test(key)) {
                link += `${(i === 0 ? "?" : "&")}${key}=${req.query[key]}`
                i++
            }
        }
        let payload = {
            date: new Date(),
            link: link
        }
        let cipherPayload = CryptoJS.AES.encrypt(JSON.stringify(payload), process.env.CERT_PASS).toString()
        let e64 = CryptoJS.enc.Base64.parse(cipherPayload)
        var eHex = e64.toString(CryptoJS.enc.Hex)
        res.status(200).json({link: `https://api.hotel-audit.hrs.com/v2/magic-login/resolve/${eHex}`})
    } catch (e) {
        switch (e.name) {
            case "PostBodyValidationError": 
                res.status(401).json({error: true, message: `${e.name}: ${e.message}`})
                break
            default:
                console.log(`${e.name}: ${e.message}`)
                res.status(400).json({error: true, message: 'Unauthorized access.'})
        }
    }
})

router.get('/resolve/:payload', async (req, res) => {
    try {
        let bytes = CryptoJS.AES.decrypt(CryptoJS.enc.Hex.parse(req.params.payload).toString(CryptoJS.enc.Base64), process.env.CERT_PASS)
        let dec = bytes.toString(CryptoJS.enc.Utf8)
        if (dec.length === 0) return res.sendStatus(403)
        let payload = JSON.parse(dec)
        if (payload.date < new Date() - (10*60)) {
            throw new MagicLoginExpiredError()
        }
        res.redirect(payload.link)
    } catch (e) {
        switch (e.name) {
            case "MagicLoginExpiredError": 
                res.status(404).json({error: true, message: `${e.name}: ${e.message}`})
                break
            default: 
                console.log(`${e.name}: ${e.message}`)
                res.status(500).json({error: true, message: 'Server error.'})
        }
    }
})

module.exports = router;