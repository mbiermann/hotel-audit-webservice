let mw = (req, res, next) => {
    req.client_id = req.body.client_id || req.query.client_id || req.headers['x-client-id'] || req.auth.client_id
    next()
}

module.exports = {
    mw: mw
}
