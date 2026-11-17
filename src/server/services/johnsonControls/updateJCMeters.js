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
const { jcLogPrefix } = require('./jcCommon.js');
const { readJCData } = require('./readJCData.js');

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
 * Data comes from the Metasys API, or from the file in JC_FILE when JC_USE_API=false (see getMeterData in readJCData.js).
 * Errors are logged rather than thrown, except when there is no database connection.
 * @returns {Promise<Array<{ name: string, isAllReadingsOk: boolean, msgTotal: string }>>}
 *   One result per meter processed. Empty if no meters were found or getting the meters failed.
 *   If an error happens after the meters are processed (for example refreshing the views),
 *   the results so far are still returned.
 */
async function updateJCMeters() {
    const results = [];

    // Get the database connection
    const conn = getConnection();
    log.info('Fetching new Johnson Controls meter data');

    // Guard clause safety check
    if (!conn) {
        throw new Error('Could not establish database connection');
    }

    try {
        // Retrieve all meters marked as enabled in the database
        const allMeters = await Meter.getEnabled(conn);

        // Narrow the list down to only Johnson Controls (Metasys) meter types
        const metersToUpdate = allMeters.filter(m => m.type === Meter.type.METASYS);
        if (metersToUpdate.length === 0) {
            log.warn(`${jcLogPrefix()} No enabled Metasys meters found`);
        }

        // Build a date range for the data request
        // TODO update this comment when buildDateRangeRequest is modified
        const dateRange = buildDateRangeRequest();

        // Records each meter's outcome (success or failure) in results. readJCData catches its own
        // errors, so updateMeters() (when used) would not see them and they have to be recorded here.
        const reader = async (meter, meterConn) => {
            results.push(await readJCData(meter, meterConn, dateRange));
        };

        // TODO - After further testing and approval by OED, run in parallel again.
        // updateMeters uses Promise.all to do all meters at once.
        // await updateMeters(reader, metersToUpdate, conn);

        // TEMP - process the meters one at a time
        log.info(`${jcLogPrefix()} Getting meter data for ${metersToUpdate.length} meter(s) in sequence`);
        for (const meter of metersToUpdate) {
            await reader(meter, conn);
        }
        log.info(`${jcLogPrefix()} Update finished`);

        // Only refresh the aggregated daily and hourly readings if something new was loaded
        if (results.some(r => r.isAllReadingsOk)) {
            await refreshDailyReadings(conn);
            await refreshHourlyReadings(conn);
        } else {
            log.warn(`${jcLogPrefix()} No meters loaded successfully, skipping reading refresh`);
        }
    } catch (err) {
        log.error(`Error fetching Johnson Controls meter data: ${err}`, err);
    }

    // Reached whether the try block succeeded or the catch handled an error
    log.info('Completed fetching new Johnson Controls meter data');
    return results;
}

module.exports = { updateJCMeters };

// Run the update when this file is run directly (e.g., npm run updateJCMeters or cron),
// but do not run it when the file is imported so the function can be used elsewhere (jcTest.js).
if (require.main === module) {
    updateJCMeters()
        .catch(err => {
            log.error(`Johnson Controls update failed: ${err}`, err);
        });
}