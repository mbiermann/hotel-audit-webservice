const jwt = require('jsonwebtoken')

let validate = (req) => {
    return new Promise((resolve, reject) => {
        if (req.auth) {
            //if ((req.auth.grants === 'general_access') || req.originalUrl.match(new RegExp(req.auth.grants))) return resolve()
            //reject(new Error(`Path not allowed for client ID ${req.auth.client_id}`))        
            return resolve()
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