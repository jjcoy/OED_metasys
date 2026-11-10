/*
* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this
* file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/

const Meter = require('../../models/Meter.js');
const { getConnection } = require('../../db.js');
const { log } = require('../../log.js');
const { refreshDailyReadings, refreshHourlyReadings } = require('../../models/Reading.js');
// Not used while the meters are processed in sequence. See the TODO in updateJCMeters().
// const updateMeters = require('../updateMeters.js');
const parseJC = require('./parsingRequest.js');
const { readJCData, buildDateRangeRequest } = require('./readJCData.js');

/**
 * Fetches and loads readings for all enabled Johnson Controls (Metasys) meters, then refreshes
 * the daily and hourly reading views if at least one meter loaded successfully.
 * Data comes from the file in JC_FILE, or from the Metasys API when JC_USE_API=true (see getMeterData in readJCData.js).
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
        const dateRange = buildDateRangeRequest();

        // Records each meter's outcome, saving errors since
        // updateMeters would discard what the reader returns. readJCData catches its own
        // errors, so updateMeters would never see them and they must be recorded here.
        const reader = async (meter, meterConn) => {
            results.push(await readJCData(meter, meterConn, dateRange));
        };

        // TODO - After further testing and approval by OED, run in parallel again. 
        // updateMeters uses Promise.all to do all meters at once.
        // await updateMeters(reader, metersToUpdate, conn);

        // TEMP - process the meters one at a time
        log.info(`${parseJC.jcLogPrefix()} Getting meter data for ${metersToUpdate.length} meter(s) in sequence`);
        for (const meter of metersToUpdate) {
            await reader(meter, conn);
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

module.exports = { updateJCMeters };