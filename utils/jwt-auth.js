const jwt = require('jsonwebtoken')

let validate = (req) => {
    return new Promise((resolve, reject) => {
        if (req.auth) {
            resolve()
        } else {
            reject('No token provided.')
        }
    })    
}

let middleware = (req, res, next) => {
    const token = req.body.token || req.query.token || req.headers['x-access-token']
    if (token) {
        jwt.verify(token, process.env.JWT_TOKEN_SECRET, function(err, decoded) {
            if (!err) req.auth = decoded
            next()
        })
    } else {
        next()
    }
}

module.exports = {
    middleware: middleware,
    validate: validate
}