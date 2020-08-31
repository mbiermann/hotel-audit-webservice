const mysql = require('mysql')
const logger = require('../utils/logger')

const poolConfig = JSON.parse(process.env.SQL_CONFIG);
poolConfig.connectionLimit = 50
let pool  = mysql.createPool(poolConfig);

const query = (query, values, handler) => {
    return new Promise((resolve, reject) => {
        pool.query(query, values, (err, results, fields) => {
            if (err) {
                logger.logEvent(logger.EventAuditDatabaseQueryError, {"error": err})
                return reject(err);
            }
            resolve(handler(results, fields));
        })
    });
}

const select = (table, clause = '', columns = '*', sortClause = '', skip = 0, limit = 0) => {
    let lim = (skip > 0 || limit > 0) ? `LIMIT ${skip}, ${limit}` : ''
    let q = `SELECT ${columns} FROM ${table} ${clause} ${sortClause} ${lim}`
    return query(q, {}, identity => identity)
}

module.exports = {

    query: query,
    select: select,
    escape: mysql.escape

}

