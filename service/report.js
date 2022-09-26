const db = require('../client/database')
const storage = require('../service/storage')
const logger = require('../utils/logger')
const XLSX = require('xlsx')
const AdmZip = require('adm-zip')
const os = require('os')
const cache = require('../client/cache')
const { v4: uuidv4 } = require('uuid');
const ExcelJS = require('exceljs')
const fs = require('fs')
const {default: PQueue} = require('p-queue')


const tmpDirPath = os.tmpdir()

module.exports = {
    createReport: (type) => {
       return new Promise((resolve1, reject1) => {
            const incr = 1000
            let table = type === 'gsi2' ? 'gsi2_reports' : 'hotels'
            let countCols = type === 'gsi2' ? 'COUNT(DISTINCT hkey) as count' : 'COUNT(hkey) as count'
            let cols = type === 'gsi2' ? 'DISTINCT hkey' : 'hkey'
            let programs = {clean: (type === 'clean'), green: (type === 'green'), gsi2: (type === 'gsi2')}
            let headers = []
            const reportKey = uuidv4()  

            db.select(table, '', countCols).then(async res1 => {
                const total = Number(res1[0].count)
                const queue = new PQueue({concurrency: 20})
                let finish = async () => {
                    let proms = []
                    let newFilePath = `${tmpDirPath}/${type}_out.xlsx`
                    const fileStream = fs.createWriteStream(newFilePath)
                    fileStream.on('error', (err) => console.log(err))
                    fileStream.on('end', (ev) => console.log(ev))
                    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({stream: fileStream});
                    const worksheet = workbook.addWorksheet('Report');        
                    worksheet.columns = headers.map(x => {return {header: x, key: x}})

                    for (let m = 0; m < total; m++) {

                        proms.push(new Promise((resolve, reject) => {
                            cache.get(`${reportKey}:${m}`, (err, val) => {
                                if (!!val) {
                                    let obj = JSON.parse(val)
                                    let outLine = {}
                                    headers.forEach(col => {
                                        outLine[col] = (obj[col] ? obj[col] : null)
                                    })
                                    worksheet.addRow(outLine).commit()
                                }
                                resolve()
                            })
                        }))
                    }
                    await Promise.all(proms)
                    
                    worksheet.commit()
                    await workbook.commit()
                    
                    let zipFilePath = newFilePath.replace(".", "_") + ".zip"
                    logger.logEvent(logger.ReportRunStatusUpdate, {stage: `start_zip_${type}`})
                    var zip = new AdmZip();
                    zip.addLocalFile(newFilePath)
                    zip.writeZip(zipFilePath)
                    logger.logEvent(logger.ReportRunStatusUpdate, {stage: `end_zip_${type}`})
                    resolve1(zipFilePath)
                }
                queue.on('error', error => {
                    console.error(error);
                })
                queue.on('idle', () => {
                    console.log(`Queue is idle.  Size: ${queue.size}  Pending: ${queue.pending}`);
                    if (queue.size === 0 && queue.pending === 0) {
                        console.log("Wrapping up")
                        finish()
                    }
                })
                queue.on('add', () => {
                    console.log(`Task is added.  Size: ${queue.size}  Pending: ${queue.pending}`);
                });
                
                queue.on('next', () => {
                    console.log(`Task is completed.  Size: ${queue.size}  Pending: ${queue.pending}`);
                });

                for (let i = 0; i < total; i += incr) {
                    queue.add(() => {return new Promise(async (resolve, reject) => {
                        logger.logEvent(logger.ReportRunStatusUpdate, {page: i, incr: incr, stage: `start_fetch_${type}`})
                        let res2 = await db.select(table, '', cols, 'ORDER BY hkey asc', skip = i, limit = incr)
                        let hkeys = res2.map(val => val.hkey)
                        let statuses = await storage.getHotelStatusByHkeys(hkeys, programs, true, true, false, true, ['code'])
                        for (let j = 0; j < statuses.length; j++) {
                            for (key of Object.keys(statuses[j])) if (headers.indexOf(key) === -1 && !!statuses[j][key]) headers.push(key)
                            cache.set(`${reportKey}:${i+j}`, JSON.stringify(statuses[j]), 'EX', 4000)
                        }
                        logger.logEvent(logger.ReportRunStatusUpdate, {page: i, incr: incr, count_statuses: statuses.length})
                        resolve()
                    })})
                }
               
                
                
            }) 
        })
    }
}