/*
* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this
* file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/

const moment = require('moment');
const Meter = require('../../models/Meter.js');
const Reading = require('../../models/Reading');
const { getConnection } = require('../../db.js');
const { log } = require('../../log.js');
const { refreshDailyReadings, refreshHourlyReadings } = require('../../models/Reading.js');
const updateMeters = require('../updateMeters.js');
const { meterTimezone } = require('../meterTimezone');
const parseJC = require('./parsingRequest.js')

// TODO Files are using space indenting and that needs to be fixed.

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
    return parseJC.loadJCReadings(meter, conn, rawData);
}

/**
 * Builds a date range request object for fetching meter data.
 * The last time the meter was enabled should be the default start time.
 * Defaults to the past 24 hours if no arguments are provided.
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

// TODO should this take a conn? Maybe yes if calling function has it.
/**
 * For the provided meter, it returns the date as an ISO string to use for the next Metasys request
 * for that meter. The value is the latest reading endTimestamp for that meter.
 * If there is no readings for that meter then it will return a very early date
 * to indicate all Metasys readings should be acquired for that meter.
 * @param {Meter) meter The meter object for the meter desired.
 * @returns {Promise<string>}
 */
async function nextJCMeterStartDate(meter) {
    // This is the date as a string to return if there are no readings for this meter.
    // It is a very early date and somewhat arbitrary but set to the
    // first Unix date for now in ISO format.
    const DEFAULT_EARLY_DATE = '1970-01-01T00:00:00Z';
    // Establish a connection to the database before any operations
    const conn = await getConnection();
    // Get the latest end timestamp for this meter.
    let returnDate = await Reading.getLastEndtimeByMeterId(meter.id, conn);
    if (returnDate === null) {
        // The meter has no readings so use the default, early date.
        returnDate = DEFAULT_EARLY_DATE;
    } else {
        // TODO Verify that this is what gives correct value, esp. since Metasys is end only.
        // The next reading has a start time that is the same as the last reading's end time
        // so use the last endtime to start the next request.
        // OED returns readings in UTC even though they are in the meter time zone reference
        // if that is used as is done for Metasys. Thus, must shift the time to UTC for the
        // next date/time request. Thus, make this in the meter time zone and then shift to UTC.
        // First determine the best guess of the meter time zone.
        const meterZone = await meterTimezone(meter);
        // Next change the date/time to be in the meter time zone without changing the date/time.
        // This keeps the time the same but applies the time zone.
        const dateMeterTz = moment(returnDate).tz(meterZone, true);
        // Now put the time in UTC.
        const dateUtc = dateMeterTz.utc();
        // Want as a canonical string format for date/time for Metasys which is ISO.
        returnDate = dateUtc.toISOString();
    }
    return returnDate;
}

/**
 * Processes meter readings from a JSON data file and uploads them to OED database.
 * Handles data validation, reliability checks, and reading transformations.
 * @returns {Promise<void>}
 */
async function updateJCMeters() {
    // Establish a connection to the database before any operations
    const conn = await getConnection();
    log.info('Fetching new Johnson Controls meter data');

    // Guard clause: abort early if no DB connection could be made
    if (!conn) {
        throw new Error('Could not establish database connection');
    }

    log.info('Attempting to upload readings to JCData meter...');
    try {
        // Retrieve all meters marked as enabled in the database
        const allMeters = await Meter.getEnabled(conn);

        // Narrow the list down to only Johnson Controls meter types,
        // since this function is specifically responsible for JC data
        const metersToUpdate = allMeters.filter(m => m.type === Meter.type.JOHNSONCONTROLS);

        // Build a date range for the data request (defaults to the last 24 hours)
        const { startDate, endDate } = buildDateRangeRequest();

        // TODO - Don't make requests in parallel
        // Iterate over each JC meter and fetch+store its readings for the date range.
        // JCMeterRequest handles the actual API call to Johnson Controls per meter.
        await updateMeters(
            (meter, conn) => processMeter(meter, conn, startDate, endDate),
            metersToUpdate,
            conn
        );

        // TODO - Update
        // Refresh the materialized/aggregated daily readings table
        // so downstream consumers see up-to-date daily totals
        await refreshDailyReadings(conn);

        // Refresh the materialized/aggregated hourly readings table
        // so downstream consumers see up-to-date hourly breakdowns
        await refreshHourlyReadings(conn);

    } catch (err) {
        // Log the full error object alongside the message for stack trace visibility
        log.error(`Error fetching Johnson Controls meter data: ${err}`, err);
    }

    // Confirmation log — reached whether the try block succeeded or the catch handled an error
    log.info('Completed fetching new Johnson Controls meter data');
}

// TODO - TEMP
async function main() {
    try {
        const conn = await getConnection();

        // TODO
        const meter = await Meter.getByName('JCData', conn);
        if (!meter) throw new Error('Meter JCData not found');

        const { startDate, endDate } = buildDateRangeRequest();
        log.info(`${parseJC.jcLogPrefix(meter.name)} Found meter (ID: ${meter.id}), starting import...`);

        const result = await processMeter(meter, conn, startDate, endDate);

        if (result.isAllReadingsOk) {
            await refreshDailyReadings(conn);
            await refreshHourlyReadings(conn);
            log.info(`${parseJC.jcLogPrefix(meter.name)} Successfully uploaded readings`);
        } else {
            log.error(`${parseJC.jcLogPrefix(meter.name)} Failed to upload readings: ${result.msgTotal}`);
        }
    } catch (error) {
        log.error(`[JC] main() failed: ${error.stack || error.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { nextJCMeterStartDate, updateJCMeters, buildDateRangeRequest, processMeter, getMeterData };
