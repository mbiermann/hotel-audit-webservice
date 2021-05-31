const jwt = require('jsonwebtoken')

let validate = (req) => {
    return new Promise((resolve, reject) => {
        const token = req.body.token || req.query.token || req.headers['x-access-token']
        if (!token) {
            return reject('No token provided.')
        }
        jwt.verify(token, process.env.JWT_TOKEN_SECRET, function(err, decoded) {
            if (err) return reject(err)
            req.auth = decoded
            resolve()
        })
    })
}

let middleware = (req, res, next) => {
    const token = req.body.token || req.query.token || req.headers['x-access-token']
    if (token) {
        jwt.verify(token, process.env.JWT_TOKEN_SECRET, function(err, decoded) {
            if (err) {
                return res.status(401).json({
                    "error": true, 
                    "message": 'Unauthorized access.' 
                })
            }
            req.auth = decoded
            next()
        })
    } else {
        return res.status(403).send({
            "error": true,
            "message": 'No token provided.'
        })
    }
}

module.exports = {
    middleware: middleware,
    validate: validate
}