/*
* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this
* file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/

const Meter = require('../../models/Meter.js');
const { getConnection, dropConnection } = require('../../db.js');
const { log } = require('../../log.js');
const { refreshDailyReadings, refreshHourlyReadings } = require('../../models/Reading.js');
// Not used while the meters are processed in sequence. See the TODO in updateJCMeters().
// const updateMeters = require('../updateMeters.js');
const parseJC = require('./parsingRequest.js');

/**
 * Get data for a meter. File by default, live API if JC_USE_API=true.
 * @param {Object} meter
 * @param {string} startDate - ISO 8601
 * @param {string} endDate - ISO 8601
 * @returns {Promise<Object>} JC API JSON
 */
async function getMeterData(meter, startDate, endDate) {
    if (process.env.JC_USE_API === 'true') {
        const jcApi = require('./jcApiClient.js');
        log.info(`${parseJC.jcLogPrefix(meter.name)} JC_USE_API=true: fetching from the Metasys API`);
        return jcApi.fetchJCMeterDataFromURI(startDate, endDate);
    }

    const filePath = process.env.JC_FILE;
    if (!filePath) {
        throw new Error('JC_FILE is not set');
    }

    log.info(`${parseJC.jcLogPrefix(meter.name)} Reading from file: ${filePath}`);
    return parseJC.fetchJCMeterDataFromFile(filePath);
}

/**
 * Get data, then parse and load it.
 * @param {Object} meter
 * @param {Object} conn
 * @param {string} startDate
 * @param {string} endDate
 * @returns {Promise<{ isAllReadingsOk: boolean, msgTotal: string }>}
 */
async function processMeter(meter, conn, startDate, endDate) {
    const rawData = await getMeterData(meter, startDate, endDate);
    return parseJC.loadJCReadings(meter, rawData, conn);
}

/**
 * Builds a date range request object for fetching meter data.
 * Defaults to the past 24 hours if no arguments are provided.
 * TODO - Consider using the time of the meter's last reading as the default start time.
 *
 * @param {Date} startDate - Start of the date range (default: 24 hours ago)
 * @param {Date} endDate - End of the date range (default: now)
 * @returns {{ startDate: string, endDate: string }} ISO 8601 formatted date strings
 *
 * @example
 * // Default usage — last 24 hours
 * buildDateRangeRequest();
 * // => { startDate: '2024-01-14T10:00:00.000Z', endDate: '2024-01-15T10:00:00.000Z' }
 *
 * @example
 * // Custom range
 * buildDateRangeRequest(new Date('2024-01-01'), new Date('2024-01-07'));
 * // => { startDate: '2024-01-01T00:00:00.000Z', endDate: '2024-01-07T00:00:00.000Z' }
 */
function buildDateRangeRequest(
    startDate = new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 hrs ago: 24h * 60m * 60s * 1000ms
    endDate = new Date()                                      // Current timestamp
) {
    // Convert both Date objects to ISO 8601 strings (e.g. "2024-01-15T10:30:00.000Z")
    // ISO 8601 is used to ensure a consistent, timezone-agnostic format for API requests
    return {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString()
    };
}


/**
 * Fetches and loads readings for all enabled Johnson Controls (Metasys) meters, then refreshes
 * the daily and hourly reading views if at least one meter loaded successfully.
 * Data comes from the file in JC_FILE, or from the Metasys API when JC_USE_API=true (see getMeterData).
 * Errors are logged rather than thrown.
 * @returns {Promise<Array<{ name: string, isAllReadingsOk: boolean, msgTotal: string }>>}
 *   One result per meter processed. Empty if no meters were found or an error stopped the update.
 */
async function updateJCMeters() {
    const results = [];

    // Establish a connection to the database before any operations
    const conn = await getConnection();
    log.info('Fetching new Johnson Controls meter data');

    // Guard clause: abort early if no DB connection could be made
    if (!conn) {
        throw new Error('Could not establish database connection');
    }

    try {
        // Retrieve all meters marked as enabled in the database
        const allMeters = await Meter.getEnabled(conn);

        // Narrow the list down to only Johnson Controls (Metasys) meter types,
        // since this function is specifically responsible for JC data
        const metersToUpdate = allMeters.filter(m => m.type === Meter.type.METASYS);
        if (metersToUpdate.length === 0) {
            log.warn(`${parseJC.jcLogPrefix()} No enabled Metasys meters found`);
        }

        // Build a date range for the data request (defaults to the last 24 hours)
        const { startDate, endDate } = buildDateRangeRequest();

        // Record each meter's result here since updateMeters would discard what the callback returns.
        // Errors are caught here too since updateMeters would only log them and hide them from results.
        const processAndRecord = async (meter, meterConn) => {
            try {
                const { isAllReadingsOk, msgTotal } = await processMeter(meter, meterConn, startDate, endDate);
                results.push({ name: meter.name, isAllReadingsOk, msgTotal });
                if (isAllReadingsOk) {
                    log.info(`${parseJC.jcLogPrefix(meter.name)} Successfully uploaded readings`);
                } else {
                    log.error(`${parseJC.jcLogPrefix(meter.name)} Failed to upload readings: ${msgTotal}`);
                }
            } catch (err) {
                results.push({ name: meter.name, isAllReadingsOk: false, msgTotal: err.message });
                log.error(`${parseJC.jcLogPrefix(meter.name)} Error processing meter: ${err.message}`, err);
            }
        };

        // TODO - Decide whether to run in parallel again. updateMeters uses Promise.all to do all meters at once.
        // await updateMeters(processAndRecord, metersToUpdate, conn);

        // TEMP - process the meters one at a time
        log.info(`${parseJC.jcLogPrefix()} Getting meter data for ${metersToUpdate.length} meter(s) in sequence`);
        for (const meter of metersToUpdate) {
            await processAndRecord(meter, conn);
        }
        log.info(`${parseJC.jcLogPrefix()} Update finished`);

        // Only refresh the aggregated daily and hourly readings if something new was loaded
        if (results.some(r => r.isAllReadingsOk)) {
            await refreshDailyReadings(conn);
            await refreshHourlyReadings(conn);
        } else {
            log.warn(`${parseJC.jcLogPrefix()} No meters loaded successfully, skipping reading refresh`);
        }
    } catch (err) {
        // TODO - Decide whether this should rethrow instead of swallowing the error
        log.error(`Error fetching Johnson Controls meter data: ${err}`, err);
    }

    // Reached whether the try block succeeded or the catch handled an error
    log.info('Completed fetching new Johnson Controls meter data');
    return results;
}

/**
 * Runs updateJCMeters() directly, e.g. JC_FILE=<path> node updateJCMeters.js.
 * Exits with code 1 if no meters were processed or any meter failed to load.
 * TODO - TEMP: remove once updateJCMeters is run from the cron job.
 */
async function main() {
    try {
        const results = await updateJCMeters();
        if (results.length === 0 || results.some(r => !r.isAllReadingsOk)) {
            log.error(`${parseJC.jcLogPrefix()} Update did not complete successfully: ${JSON.stringify(results)}`);
            process.exitCode = 1;
        }
    } catch (error) {
        log.error(`[JC] main() failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    } finally {
        // Close the DB pool so the process exits now instead of waiting for idle connections to time out.
        // Only done here since the cron job will share the server's pool.
        dropConnection();
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { updateJCMeters, buildDateRangeRequest, processMeter, getMeterData };