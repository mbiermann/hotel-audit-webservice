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
const auth = require('./controller/auth.js')
const {trackEvent} = require('./service/tracking')
const storage = require('./service/storage')
const swaggerUi = require('swagger-ui-express')
const YAML = require('yamljs')
const swaggerDocument = YAML.load('./swagger.yaml')
const {middleware: jwtAuth} = require('./utils/jwt-auth')

const {combinedAuthMiddleware: combinedAuthMiddleware} = require('./utils/auth-middleware')

process.env.service_name = package.name

app.use(blocker.middleware)
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument /*, { explorer: true }*/))
app.use(compression())
app.use(bodyParser.json())
app.use(cors())

app.use('/auth', auth)

app.get('/jwt-test', combinedAuthMiddleware, (req, res) => {
    res.status(200).json(req.auth)
})

app.use('/v1', v1)

app.get('/favicon.ico', (req, res) => res.status(200))

const request = require('request')

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('Hotel Audit Webserive listening on port', port, 'in mode', process.env.MODE) );