const { measure } = require('measurement-protocol')

module.exports = {
    trackEvent: (category, action, label) => {
        measure(process.env.GA_TRACKING_ID).event(category, action, label).send()
    }
}