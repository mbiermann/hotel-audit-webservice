const storage = require('../service/storage')

module.exports = {
    getWebhooks: (req, res) => {
        storage.getWebhooksForClientID(req.client_id).then(webhooks => {
            res.status(200).json(webhooks)
        }).catch(err => {
            console.log(`Error getting webhook records from storage for client ID ${req.client_id}: ${err}`)
            res.sendStatus(403)
        })
    },
    createWebhook: (req, res) => {
        if (!("url" in req.body) || req.body.url === null || req.body.url === "" || !/http[s]?\:\/\/.+/.test(req.body.url)) {
            res.status(400).send("Please provide a valid URL beginning with http(s)://.")
        } else {
            let checkEndpointAlreadyExists = (url, client_id) => {
                return new Promise((resolve, reject) => {
                    storage.getWebhooksForClientID(client_id).then(webhooks => {
                        for (wh of webhooks) {
                            if (wh.url === url) reject("Conflict: Endpoint already registered for this client ID.")
                        }
                        resolve()
                    })
                })
            }
            checkEndpointAlreadyExists(req.body.url, req.client_id).then(() => {
                storage.saveWebhookForClientID(req.client_id, req.body.url).then((id) => {
                    res.status(200).json({id: id})
                }).catch(err => {
                    console.log(`Error creating webhook for client ID ${req.client_id}: ${err}`)
                    res.sendStatus(403)
                })
            }).catch(e => {
                res.status(409).json({error: e})
            })
        }
    },
    deleteWebhook: (req, res) => {
        storage.deleteWebhookForClientID(req.client_id, req.params.id).then((id) => {
            res.status(200).send(`Webhook resource deleted with ID: ${id}`)
        }).catch(err => {
            const errMsg = `Error deleting webhook ${req.params.id} for client ID ${req.client_id}: ${err}`
            console.log(errMsg)
            res.status(403).send(errMsg)
        })
    }
}