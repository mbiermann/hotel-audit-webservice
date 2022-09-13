require('custom-env').env()
const compression = require('compression')
const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const app = express();
const logger = require('./utils/logger')
const package = require('./package.json')
const v1 = require('./controller/v1.js')
const v2 = require('./controller/v2.js')
const auth = require('./controller/auth.js')
const {trackEvent} = require('./service/tracking')
const storage = require('./service/storage')
const swaggerUi = require('swagger-ui-express')
const YAML = require('yamljs')
const swaggerDocument = YAML.load('./swagger.yaml')
const {middleware: jwtAuthMiddleware} = require('./utils/jwt-auth')

process.env.service_name = package.name

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument /*, { explorer: true }*/))
app.use(compression())
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))
app.use(cors())

app.use(jwtAuthMiddleware)
app.use('/auth', auth)
app.use('/v1', v1)
app.use('/v2', v2)

app.get('/favicon.ico', (req, res) => res.status(200))


const port = process.env.PORT || 8080;
app.listen(port, () => console.log('Hotel Audit Webserive listening on port', port, 'in mode', process.env.MODE) );