const {Storage} = require('@google-cloud/storage')

exports.uploadFile = (filename) => {
    return new Storage().bucket('hs-report').upload(filename, {gzip: true})
}

exports.readFileStream = (filename) => {
    return new Storage().bucket('hs-report').file(filename).createReadStream()
}