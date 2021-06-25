const {validate: validateJWTAccess} = require('./jwt-auth')
const monitoring = require('@google-cloud/monitoring')
const {nanoid} = require('nanoid')


const middleware = (req, res, next) => {
   /* let prom = new Promise(async (resolve, reject) => {
        const client = new monitoring.MetricServiceClient();

        const dataPoint = {
            interval: {
                endTime: {
                    seconds: Date.now() / 1000,
                }
            },
            value: {
                doubleValue: 1,
            }
        };

        const timeSeriesData = {
            metric: {
                type: 'custom.googleapis.com/api/requests',
                labels: {
                    client_id: ('auth' in req && 'client_id' in req.auth) ? req.auth.client_id : 'unkown',
                    path: req.originalUrl.match(/^(\/[^\?\#]*).*$/)[1],
                    ip: (req.headers['x-forwarded-for'] || req.connection.remoteAddress),
                    request_id: nanoid()
                }
            },
            resource: {
                type: 'global',
                labels: {
                    project_id: process.env.GC_PROJECT_ID
                }
            },
            points: [dataPoint]
        }

        const request = {
            name: client.projectPath(process.env.GC_PROJECT_ID),
            timeSeries: [timeSeriesData]
        };

        const result = await client.createTimeSeries(request);
    })
    
    if (!req.monitoringProms) req.monitoringProms = []
    req.monitoringProms.push(prom)
    */
    next()
}

module.exports = middleware