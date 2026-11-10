/*
* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this
* file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/

const { log } = require('../../log.js');
const parseJC = require('./parsingRequest.js');

/**
 * Get the Metasys connection information from a meter's url in the database:
 *   <host>/api/v3?username=<username>&password=<password>&fqr=<fqr>
 * The url in the DB should not include https:// since we add it here.
 * The path (/api/v3) is kept as the base url the API client adds to.
 * @param {Object} meter
 * @returns {{ baseUrl: string, username: string, password: string, fqr: string }}
 * @throws {Error} if the url is missing or does not have a username, password and fqr. The message never includes
 *   the url because it holds the password.
 */
function getCredentialsFromMeter(meter) {
    // make sure there is a url stored for this meter before we get too far.
    if (!meter.url) {
        throw new Error(`Meter ${meter.name} has no url.`);
    }
    // build the full url
    let url;
    try {
        // The url should be stored as eGauge meters are, so https:// is added here.
        url = new URL(`https://${meter.url}`);
    } catch (err) {
        throw new Error(`The url for meter ${meter.name} is not a valid url`);
    }
    // build credentials needed
    const credentials = {
        // No trailing slash since the API client adds /login, /objects, etc.
        baseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/, ''),
        username: url.searchParams.get('username'),
        password: url.searchParams.get('password'),
        fqr: url.searchParams.get('fqr')
    };
    // check for missing parts needed to build a valid url
    const missing = ['username', 'password', 'fqr'].filter(key => !credentials[key]);
    if (missing.length > 0) {
        throw new Error(`The url for meter ${meter.name} is missing: ${missing.join(', ')}`);
    }
    // return credentials retrieved from the database's meter entry
    return credentials;
}

/**
 * Get data for a meter. File by default, live API if JC_USE_API=true.
 * @param {Object} meter
 * @param {string} startDate - ISO 8601
 * @param {string} endDate - ISO 8601
 * @returns {Promise<Object>} JC API JSON
 */
async function getMeterData(meter, startDate, endDate) {
    // get data from meter
    if (process.env.JC_USE_API === 'true') {
        const jcApi = require('./jcApiClient.js');
        log.info(`${parseJC.jcLogPrefix(meter.name)} JC_USE_API=true: fetching from the Metasys API`);
        // Each meter has its own connection information so each one asks its own server for its own fqr.
        return jcApi.fetchJcMeterData(startDate, endDate, getCredentialsFromMeter(meter));
    }
    // if testing, read data from a file that is set as JC_FILE when jcTests.js is run
    else {
        const filePath = process.env.JC_FILE;
        if (!filePath) {
            throw new Error('JC_FILE is not set');
        }

        log.info(`${parseJC.jcLogPrefix(meter.name)} Reading from file: ${filePath}`);
        return parseJC.fetchJCMeterDataFromFile(filePath);
    }
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
 * Acquires JC readings for one OED meter and stores them in the database.
 * Errors are caught and returned so the caller can record a per-meter outcome.
 * @param {Object} meter
 * @param {Object} conn
 * @param {{ startDate: string, endDate: string }} [dateRange] defaults to the last 24 hours
 * @returns {Promise<{ name: string, isAllReadingsOk: boolean, msgTotal: string }>}
 */
async function readJCData(meter, conn, dateRange = buildDateRangeRequest()) {
    try {
        const rawData = await getMeterData(meter, dateRange.startDate, dateRange.endDate);
        // detect some errors here and log them, before exiting this function
        const { isAllReadingsOk, msgTotal } = await parseJC.loadJCReadings(meter, rawData, conn);
        if (isAllReadingsOk) {
            log.info(`${parseJC.jcLogPrefix(meter.name)} Successfully uploaded readings`);
        } else {
            log.error(`${parseJC.jcLogPrefix(meter.name)} Failed to upload readings: ${msgTotal}`);
        }
        return { name: meter.name, isAllReadingsOk, msgTotal };
    } catch (err) {
        log.error(`${parseJC.jcLogPrefix(meter.name)} Error processing meter: ${err.message}`, err);
        return { name: meter.name, isAllReadingsOk: false, msgTotal: err.message };
    }
}

module.exports = { readJCData, getMeterData, buildDateRangeRequest };
