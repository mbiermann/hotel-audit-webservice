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
        storage.saveWebhookForClientID(req.client_id, req.body.url).then((id) => {
            res.status(200).json({id: id})
        }).catch(err => {
            console.log(`Error creating webhook for client ID ${req.client_id}: ${err}`)
            res.sendStatus(403)
        })
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