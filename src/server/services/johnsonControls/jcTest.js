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
 * npm run testjc -- load  <meterName> <file> [cleanup]
 *   cleanup restores the database to how it was before the load.
 * npm run testjc -- delete <meterName>
 *   delete removes a meter made by testLoad, along with everything that refers to it.
 */

const { log, LogLevel } = require('../../log');
const { getConnection, dropConnection } = require('../../db');
const Meter = require('../../models/Meter');
const Unit = require('../../models/Unit');
const Reading = require('../../models/Reading');
const {
    jcLogin,
    getObjectUuid,
    authHeader,
    buildSampleUri,
    fetchJcMeterData
} = require('./jcApiClient');
const {
    fetchJCMeterDataFromFile,
    loadJCReadings
} = require('./parsingRequest');
const fs = require('fs');
const moment = require('moment');

// Start of the note put on meters made by this file. deleteTestMeter uses it to only delete test meters.
const TEST_METER_NOTE = 'created via JC TESTING on ';

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
        TEST_METER_NOTE + moment().format(), // note
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
 * Record what the database holds for a meter so cleanUpLoad can put it back.
 * Must be taken before getOrCreateMeter and before any readings are loaded.
 * Note the snapshot of the readings is held in memory so it would be slow for a meter with many readings.
 * @param meterName meter name
 * @param conn database connection
 * @returns snapshot to give to cleanUpLoad. meter and readings are null if the meter did not exist.
 */
async function snapshotMeter(meterName, conn) {
    const meter = await Meter.getByName(meterName, conn).catch(() => null);
    const readings = meter ? await Reading.getAllByMeterID(meter.id, conn) : null;
    return { meterName, meter, readings };
}

/**
 * Undo what testLoad did so the database is as it was before the test.
 * If the meter did not exist then its readings and the meter are deleted.
 * If the meter already existed then its readings and meter row are put back to the snapshot.
 * @param snapshot value from snapshotMeter taken before the load
 * @param conn database connection
 */
async function cleanUpLoad(snapshot, conn) {
    const { meterName, meter, readings } = snapshot;
    if (!meter) {
        // The meter did not exist before the test so remove it and its readings.
        await deleteTestMeter(meterName, conn);
    } else {
        // The meter was there before so put back the readings and the meter values the load changed.
        await conn.none('DELETE FROM readings WHERE meter_id = $1', [meter.id]);
        await Reading.insertOrUpdateAll(readings, conn);
        await meter.update(conn);
        logMsg(`Clean up: restored meter ${meterName} (id ${meter.id}) and its ${readings.length} readings`);
    }
}

/**
 * Completely delete a meter made by getOrCreateMeter, including its readings and anything else that refers to it.
 * Use this to remove a test meter after running testLoad without cleanup.
 * Only meters with the test note are deleted so a real meter cannot be removed by mistake.
 * @param meterName meter name
 * @param conn database connection. A new one is used if not given.
 */
async function deleteTestMeter(meterName, conn = getConnection()) {
    if (!meterName) {
        throw new Error('A meter name is needed');
    }
    // Find the meter. It may not exist if it was already deleted.
    const meter = await Meter.getByName(meterName, conn).catch(() => null);
    if (!meter) {
        logMsg(`Meter ${meterName} not found so nothing to delete`);
    } else if (!meter.note || !meter.note.startsWith(TEST_METER_NOTE)) {
        // Safety check: refuse to delete a meter that was not made by this test code.
        throw new Error(`Meter ${meterName} (id ${meter.id}) was not made by JC testing so it was not deleted`);
    } else {
        // Delete in one transaction. Tables that refer to the meter go first because of the foreign keys
        // and the meter row goes last. Either everything is deleted or nothing is.
        await conn.tx(async t => {
            await t.none('DELETE FROM readings WHERE meter_id = $1', [meter.id]);
            await t.none('DELETE FROM baseline WHERE meter_id = $1', [meter.id]);
            // These two are for if the test meter was added to a group or meter hierarchy while viewing it in the app.
            await t.none('DELETE FROM groups_immediate_meters WHERE meter_id = $1', [meter.id]);
            await t.none('DELETE FROM meters_immediate_children WHERE parent_id = $1 OR child_id = $1', [meter.id]);
            await t.none('DELETE FROM meters WHERE id = $1', [meter.id]);
        });
        logMsg(`Deleted meter ${meterName} (id ${meter.id}) and everything that refers to it`);
    }
}

/**
 * Parse a saved file into a meter, making the meter if needed.
 * @param meterName meter name
 * @param filePath file to load
 * @param cleanup if true then the database is put back as it was after the load
 */
async function testLoad(meterName, filePath, cleanup = false) {
    if (!filePath) {
        throw new Error('A file to load is needed');
    }
    // in case the meter exists, save a snapshot in memory, so we can restore it,
    // if we are running with the cleanup option set to true
    const conn = getConnection();
    const snapshot = cleanup ? await snapshotMeter(meterName, conn) : null;
    // run the test to create the meter, open test file, parse it, load it, log result
    try {
        const meter = await getOrCreateMeter(meterName, conn);
        const rawData = await fetchJCMeterDataFromFile(filePath);
        const result = await loadJCReadings(meter, rawData, conn);
        if (result.isAllReadingsOk) {
            const itemCount = Array.isArray(rawData.items) ? rawData.items.length : 0;
            logMsg(`Loaded ${meter.name}: ${itemCount} items in the file.`);
        } else {
            logMsg(`Failed to load ${meter.name}: ${result.msgTotal}`);
        }
    } finally {
        // if we asked to clean up the db after the test, run cleanUpLoad()
        if (cleanup) {
            await cleanUpLoad(snapshot, conn);
        }
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
            await testLoad(first, second, third === 'cleanup');
            break;
        case 'delete':
            await deleteTestMeter(first);
            break;
        default:
            logMsg('Provide a command: login, uuid, uri, fetch, load, delete');
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