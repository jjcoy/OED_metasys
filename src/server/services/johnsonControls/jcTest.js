/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * TEMP - This file is used to manually test requests sent and recieved from the Metasys server
 *
 * npm run testjc -- login  --baseUrl= --username= --password=
 * npm run testjc -- uuid   --baseUrl= --username= --password= --fqr=
 * npm run testjc -- uri <start> <end> --baseUrl=
 * npm run testjc -- fetch <start> <end> <outFile> --baseUrl= --username= --password= --fqr=
 * npm run testjc -- load  <meterName> <file>
 */

const { log, LogLevel } = require('../../log');
const { getConnection, dropConnection } = require('../../db');
const Meter = require('../../models/Meter');
const Unit = require('../../models/Unit');
const {
    jcLogin,
    getObjectUuid,
    authHeader,
    buildSampleUri,
    fetchJcMeterData
} = require('./jcApiClient');
const {
    fetchJCMeterDataFromFile,
    parseJCMeterData,
    loadJCReadings
} = require('./parsingRequest');
const fs = require('fs');
const moment = require('moment');

/**
 * @param message log message
 */
function logMsg(message) {
    console.log(message);
}

/**
 * @param credentials { baseUrl, username, password, fqr }
 */
async function testLogin(credentials) {
    const { token, expiresAt } = await jcLogin(credentials.baseUrl, credentials.username, credentials.password);
    logMsg(`Logged in to ${credentials.baseUrl}`);
    logMsg(`token: ${token}`);
    logMsg(`expires at: ${new Date(expiresAt).toISOString()}`);
}

/**
 * @param credentials { baseUrl, username, password, fqr }
 */
async function testUuid(credentials) {
    const { token } = await jcLogin(credentials.baseUrl, credentials.username, credentials.password);
    const uuid = await getObjectUuid(token, credentials.baseUrl, credentials.fqr);
    logMsg(`fqr:  ${credentials.fqr}`);
    logMsg(`uuid: ${uuid}`);
}

/**
 * Print the sample url and header without making any request.
 * @param startTime start time
 * @param endTime end time
 * @param credentials { baseUrl }
 */
async function testUri(startTime, endTime, credentials) {
    if (!startTime || !endTime) {
        throw new Error('A start time and an end time are needed');
    }

    const token = '<TOKEN>';
    const uuid = '<UUID>';
    logMsg('GET: \n' + buildSampleUri(credentials.baseUrl, uuid, startTime, endTime, 1));
    logMsg('\nHEADER: \n' + JSON.stringify(authHeader(token)));
}

/**
 * Make a request and save the response to a file.
 * @param startTime start time
 * @param endTime end time
 * @param outFile file to save the response to
 * @param credentials { baseUrl, username, password, fqr }
 */
async function testFetch(startTime, endTime, outFile, credentials) {
    if (!startTime || !endTime) {
        throw new Error('A start time and an end time are needed');
    }
    if (!outFile) {
        throw new Error('No outfile provided');
    }

    const rawData = await fetchJcMeterData(startTime, endTime, credentials);
    logMsg(`Got ${rawData.items.length} samples from ${startTime} to ${endTime}`);
    if (rawData.items.length > 0) {
        logMsg(`  first sample: ${JSON.stringify(rawData.items[0])}`);
    }
    fs.writeFileSync(outFile, JSON.stringify(rawData, null, 2));
    logMsg(`Saved the response to ${outFile}`);
}

/**
 * Get the meter by name, creating it if it does not exist. The name is whatever is passed in.
 * @param meterName meter name
 * @param conn database connection
 * @returns the meter
 */
async function getOrCreateMeter(meterName, conn) {
    if (!meterName) {
        throw new Error('A meter name is needed');
    }
    const existing = await Meter.getByName(meterName, conn).catch(() => null);
    if (existing) {
        return existing;
    }
    const meterUnit = await Unit.getByName('Electric_Utility', conn).catch(() => null);
    const graphicUnit = await Unit.getByName('kWh', conn).catch(() => null);
    const unitId = meterUnit ? meterUnit.id : -99;
    const graphicUnitId = graphicUnit ? graphicUnit.id : -99;
    if (!meterUnit || !graphicUnit) {
        logMsg('Unit was not found');
    }

    const meter = new Meter(
        undefined, // id
        meterName, // name
        null, // URL
        true, // enabled
        true, // displayable
        Meter.type.METASYS, // type
        'US/Eastern', // timezone
        undefined, //gps
        undefined, // identifier
        'created via JC TESTING on ' + moment().format(), // note
        undefined, //area
        true, // cumulative
        true, //cumulativeReset
        undefined, // cumulativeResetStart
        undefined, // cumulativeResetEnd
        0, // readingGap
        0, // readingVariation
        1, //readingDuplication
        'increasing', // timeSort
        true, //endOnlyTime
        undefined, // reading
        undefined, // startTimestamp
        undefined, // endTimestamp
        undefined, // previousEnd
        unitId, // unit
        graphicUnitId, // default graphic unit
        undefined, // area unit
        'PT60M', // reading frequency
        Number.MIN_SAFE_INTEGER, // minVal
        Number.MAX_SAFE_INTEGER, // maxVal
        '1900-01-01T01:00:00Z', // minDate
        '2050-01-01T01:00:00Z', // maxDate
        200, // maxError
        Unit.disableChecksType.REJECT_ALL // disable checks
    );

    await meter.insert(conn);
    logMsg(`Made a new meter named ${meterName} (id ${meter.id})`);
    return meter;
}

/**
 * Parse a saved file into a meter, making the meter if needed.
 * @param meterName meter name
 * @param filePath file to load
 */
async function testLoad(meterName, filePath) {
    if (!filePath) {
        throw new Error('A file to load is needed');
    }
    const conn = getConnection();
    const meter = await getOrCreateMeter(meterName, conn);
    const rawData = await fetchJCMeterDataFromFile(filePath);
    const parsed = parseJCMeterData(rawData, meter);
    const result = await loadJCReadings(meter, rawData, conn);
    logMsg(`Loaded ${meter.name}: ${parsed.readings.length} readings in the file.`);
    if (!result.isAllReadingsOk) {
        logMsg(result.msgTotal);
    }
}

/**
 *   --baseUrl= --username= --password= --fqr=
 * @param args process args
 * @returns args in order
 */
function parseArgs(args) {
    const credentials = {};
    const positional = [];
    const allowed = ['baseUrl', 'username', 'password', 'fqr'];
    for (const arg of args) {
        if (arg.startsWith('--')) {
            const eq = arg.indexOf('=');
            const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
            const value = eq === -1 ? '' : arg.slice(eq + 1);
            if (allowed.includes(key)) {
                credentials[key] = value;
            } else {
                logMsg(`Unknown option --${key}. Known options: ${allowed.map(a => '--' + a).join(', ')}`);
            }
        } else {
            positional.push(arg);
        }
    }
    return { credentials, positional };
}

/**
 *
 */
async function main() {
    const { credentials, positional } = parseArgs(process.argv.slice(2));
    const [command, first, second, third] = positional;

    log.level = LogLevel.DEBUG;
    log.logToDb = false;
    log.emailLevel = LogLevel.SILENT;

    if (Object.keys(credentials).length > 0) {
        const shown = { ...credentials };
        logMsg(`Using connection: ${JSON.stringify(shown)}`);
    }

    try {
        await runCommand(command, first, second, third, credentials);
    } catch (err) {
        logMsg(err);
    } finally {
        dropConnection();
    }
}

/**
 *
 * @param command command
 * @param first first arg
 * @param second second arg
 * @param third third arg
 * @param credentials connection values from the command line
 */
async function runCommand(command, first, second, third, credentials) {
    switch (command) {
        case 'login':
            await testLogin(credentials);
            break;
        case 'uuid':
            await testUuid(credentials);
            break;
        case 'uri':
            await testUri(first, second, credentials);
            break;
        case 'fetch':
            await testFetch(first, second, third, credentials);
            break;
        case 'load':
            await testLoad(first, second);
            break;
        default:
            logMsg('Provide a command: login, uuid, uri, fetch, load');
            logMsg('Connection flags: --baseUrl= --username= --password= --fqr=');
    }
}

main()
    .then(() => {
        process.exitCode = 0;
    })
    .catch(error => {
        logMsg(`\nThat did not work: ${error.message}`);
        process.exitCode = 1;
    });