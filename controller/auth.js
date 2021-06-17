const express = require('express')
const jwt = require('jsonwebtoken')
const router = express.Router()
const storage = require('../service/storage')
const SHA256 = require("crypto-js/sha256")
const {combinedAuthMiddleware: combinedAuthMiddleware} = require('.././utils/auth-middleware')
const {unblock} = require('.././utils/blocked-middleware')


router.post('/login', async (req, res) => {
    const postData = req.body
    try {
        const auth = await storage.getAuth(postData.client_id, SHA256(postData.client_secret))
        const client = { "client_id": auth.id, "grants": auth.grants }
        const token = jwt.sign(client, process.env.JWT_TOKEN_SECRET, { expiresIn: auth.access_token_ttl})
        const refreshToken = jwt.sign(client, process.env.JWT_REFRESH_TOKEN_SECRET, { expiresIn: auth.refresh_token_ttl})
        const response = {
            "status": "Logged in",
            "token": token,
            "refreshToken": refreshToken,
        }
        unblock(req, () => {
            res.status(200).json(response)
        })
    } catch (e) {
        console.log("Error in /auth/login", e)
        res.status(401).json({
            "error": true, 
            "message": 'Unauthorized access.' 
        })
    }
})

router.post('/refresh', async (req,res) => {
    const postData = req.body
    try {
        const auth = await storage.getAuth(postData.client_id, SHA256(postData.client_secret))
        jwt.verify(postData.refreshToken, process.env.JWT_REFRESH_TOKEN_SECRET, function(err, decoded) {
            if (err) {
                throw(new Error(err))
            } else if (decoded.client_id !== postData.client_id) {
                throw(new Error("Client does not match"))
            }
        })
        const client = { "client_id": auth.id, "grants": auth.grants }
        const token = jwt.sign(client, process.env.JWT_TOKEN_SECRET, { expiresIn: auth.access_token_ttl})
        const response = { "token": token }
        res.status(200).json(response)
    } catch (e) {
        console.log("Error in /auth/refresh", e)
        return res.status(401).json({
            "error": true, 
            "message": 'Unauthorized access.' 
        })
    }
    
})

router.get('/jwt-test', (req, res) => {
    if (req.auth) {
         res.status(200).json(req.auth)
    } else {
        res.status(401)
    }
})

module.exports = router;