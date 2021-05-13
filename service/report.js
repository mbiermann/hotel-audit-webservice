const db = require('../client/database')
const storage = require('../service/storage')
const logger = require('../utils/logger')
const XLSX = require('xlsx')
const AdmZip = require('adm-zip')
const fs = require('fs')
const os = require('os')
let csvWriter = require('csv-write-stream')

const tmpDirPath = os.tmpdir()

module.exports = {
    createReport: (type) => {
        const hsReportLocalFilePath = `${tmpDirPath}/${type}_out.csv`
        const hsReportZipLocalFilePath = `${hsReportLocalFilePath}.zip`
        const incr = 1000
        let data = []
        let headers = []
        let writer = null
        return new Promise((resolve1, reject1) => {
            new Promise((resolve2, reject2) => {
                db.select('hotels', '', 'COUNT(hkey) as count').then(async res1 => {
                    const total = Number(res1[0].count)
                    for (let i = 0; i < total; i += incr) {
                        let res2 = await db.select('hotels', '', 'hkey', 'ORDER BY hkey asc', skip = i, limit = incr)
                        let hkeys = res2.map(val => val.hkey)
                        let programs = {clean: (type === 'clean'), green: (type === 'green')}
                        let statuses = await storage.getHotelStatusByHkeys(hkeys, programs, true, true, true, ['code'])
                        if (i === 0) {
                            for (status of statuses) {
                                for (key of Object.keys(status)) if (headers.indexOf(key) === -1 && !!status[key]) headers.push(key)
                            }
                            writer = csvWriter({headers: headers})
                            writer.pipe(fs.createWriteStream(hsReportLocalFilePath))
                        }
                        for (status of statuses) {
                            let obj = []
                            for (let i = 0; i<headers.length; i++) obj.push(status[headers[i]])
                            writer.write(obj)
                        }
                        logger.logEvent(logger.ReportRunStatusUpdate, {page: i, incr: incr, count_statuses: statuses.length})
                    }         
                    writer.end()       
                    resolve2()
                })
            }).then(res => {
                logger.logEvent(logger.ReportRunStatusUpdate, {stage: `start_zip_csv_${type}`})
                var zip = new AdmZip();
                zip.addLocalFile(hsReportLocalFilePath)
                zip.writeZip(hsReportZipLocalFilePath)
                logger.logEvent(logger.ReportRunStatusUpdate, {stage: `end_zip_csv_${type}`})
                resolve1(hsReportZipLocalFilePath)
            }).catch(err => {
                logger.logEvent(logger.ReportError, {"error": err.message})
                reject1(err)
            })  
        })
    }
}