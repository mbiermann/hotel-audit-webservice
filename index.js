require('custom-env').env()
const compression = require('compression')
const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const app = express();
const logger = require('./utils/logger')
const package = require('./package.json')
const blocker = require('./utils/blocked-middleware')
const v1 = require('./controller/v1.js')
const {trackEvent} = require('./service/tracking')
const storage = require('./service/storage')

process.env.service_name = package.name

app.use(blocker.middleware)
app.use(compression())
app.use(bodyParser.json())
app.use(cors())

app.use('/v1', v1)

app.get('/favicon.ico', (req, res) => res.status(200))

const request = require('request')


const port = process.env.PORT || 8080;
app.listen(port, () => console.log('Hotel Audit Webserive listening on port', port, 'in mode', process.env.MODE) );