const db = require('../client/database')
const storage = require('../service/storage')
const logger = require('../utils/logger')
const XLSX = require('xlsx')
const AdmZip = require('adm-zip')
const fs = require('fs')
const os = require('os')
let csvWriter = require('csv-write-stream')
const cache = require('../client/cache')
const { v4: uuidv4 } = require('uuid');

const tmpDirPath = os.tmpdir()

module.exports = {
    createReport: (type) => {
       return new Promise((resolve1, reject1) => {
            const hsReportLocalFilePath = `${tmpDirPath}/${type}_out.csv`
            const hsReportZipLocalFilePath = `${hsReportLocalFilePath}.zip`
            const incr = 1000
            let table = type === 'gsi2' ? 'gsi2_reports' : 'hotels'
            let countCols = type === 'gsi2' ? 'COUNT(DISTINCT hkey) as count' : 'COUNT(hkey) as count'
            let cols = type === 'gsi2' ? 'DISTINCT hkey' : 'hkey'
            let programs = {clean: (type === 'clean'), green: (type === 'green'), gsi2: (type === 'gsi2')}
            let headers = []
            const reportKey = uuidv4()
            let index = 0
            db.select(table, '', countCols).then(async res1 => {
                const total = Number(res1[0].count)
                for (let i = 0; i < total; i += incr) {
                    logger.logEvent(logger.ReportRunStatusUpdate, {page: i, incr: incr, stage: `start_fetch_${type}`})
                    let res2 = await db.select(table, '', cols, 'ORDER BY hkey asc', skip = i, limit = incr)
                    let hkeys = res2.map(val => val.hkey)
                    let statuses = await storage.getHotelStatusByHkeys(hkeys, programs, true, true, false, true, ['code'])
                    for (let j = 0; j < statuses.length; j++) {
                        for (key of Object.keys(statuses[j])) if (headers.indexOf(key) === -1 && !!statuses[j][key]) headers.push(key)
                        cache.set(`${reportKey}:${index}`, JSON.stringify(statuses[j]), 'EX', 4000)
                        index++
                    }
                    logger.logEvent(logger.ReportRunStatusUpdate, {page: i, incr: incr, count_statuses: statuses.length})
                }
                
                let writer = csvWriter({headers: headers})
                let output = fs.createWriteStream(hsReportLocalFilePath)
                output.on('close', function() {
                    logger.logEvent(logger.ReportRunStatusUpdate, {stage: `start_zip_csv_${type}`})
                    var zip = new AdmZip();
                    zip.addLocalFile(hsReportLocalFilePath)
                    zip.writeZip(hsReportZipLocalFilePath)
                    logger.logEvent(logger.ReportRunStatusUpdate, {stage: `end_zip_csv_${type}`})
                    resolve1(hsReportZipLocalFilePath)
                })
                writer.pipe(output)
                let proms = []
                for (let m = 0; m < index; m++) {
                    proms.push(new Promise((resolve, reject) => {
                        cache.get(`${reportKey}:${m}`, (err, val) => {
                            writer.write(JSON.parse(val))
                            resolve()
                        })
                    }))
                }
                await Promise.all(proms)
                writer.end()
            }) 
        })
    }
}