
let validate = (req) => {
    return new Promise((resolve, reject) => {
        var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress
        ip = ip.split(",")[0]
        if (ip !== process.env.RESTRICTED_IP) return reject(new Error('Invalid IP'))
        resolve()
    })
}

let middleware = (req, res, next) => {
    validate(req).then(next).catch(err => 
        res.status(401).json({ error: err.message })
    )
}

module.exports = {
    validate: validate,
    middleware: middleware 
}