/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const loadArrayInput = require('../pipeline-in-progress/loadArrayInput.js');
const { log } = require('../../log.js');
const { jcLogPrefix } = require('./jcCommon.js');

/**
 * Parses raw JC meter data into readings that can be loaded into OED.
 * Problems are recorded in the result and logged, not thrown.
  * @param rawData - Raw JSON response (an object with an items array)
 * @param meter - Meter object
 * @returns { readings, warnings, errors }: readings is an array of [value, timestamp] for the items that
 *   have a numeric value (items without one are dropped without warning). warnings are for unreliable data or a unit
 *   other than kWh, and loading can continue. errors are set only if there is nothing to load (the response has
 *   no items array, or items is empty), and then readings is empty.
 */

function parseJCMeterData(rawData, meter) {
    // set up logging message for this meter
    const prefix = jcLogPrefix(meter.name);
    // prepare result to store reports
    const result = {
        readings: [],
        warnings: [],
        errors: []
    };

    // report if the rawData is null or does not contain the items array
    if (!rawData || !Array.isArray(rawData.items)) {
        const msg = 'Invalid API response structure';
        result.errors.push(msg);
        log.error(`${prefix} ${msg}`);
        return result;
    }

    // extract the items array
    const jsonItems = rawData.items;

    // if no data was returned, record an error and log it
    if (jsonItems.length === 0) {
        const msg = `No data returned from the query for meter ${meter.name} (ID: ${meter.id})`;
        result.errors.push('No data returned from the query');
        log.error(`${prefix} ${msg}`);
        return result;
    }

    // look for unreliable results.  if there are any, add to the warnings messages
    const unreliable = jsonItems.filter(
        it => it && it.isReliable === false
    ).length;
    if (unreliable > 0) {
        const msg = `Data reliability warning: isReliable flag is false for meter ${meter.name} (ID: ${meter.id})`;
        result.warnings.push(
            'Data reliability warning: isReliable flag is false'
        );
        log.warn(`${prefix} ${msg}`);
    }

    // warn if any item has a unit other than kWh (added to warnings and logged)
    // TODO: this can likely be improved
    const wrongUnit = jsonItems.find(
        it =>
            it &&
            it.value &&
            it.value.units &&
            it.value.units !== 'unitEnumSet.kwattHours'
    );
    if (wrongUnit) {
        const msg = `Unit warning: kwattHours flag is false for meter ${meter.name} (ID: ${meter.id})`;
        result.warnings.push('Unit warning: kwattHours flag is false');
        log.warn(`${prefix} ${msg}`);
    }

    // look through the jsonItems (this is rawData.items) and pull out the results
    // that contain numbers, then store into readings with the value and its timestamp
    result.readings = jsonItems
        .filter(it => it && it.value && typeof it.value.value === 'number')
        .map(it => [it.value.value, it.timestamp]);

    // log how many readings were parsed
    log.info(
        `${prefix} Parsed ${result.readings.length} valid readings from response`
    );

    // return the result object, which contains an array of readings, plus warnings
    // and errors
    return result;
}

/**
 * Parses the raw JC data and loads the valid readings into the OED database.
 * @param meter - Meter
 * @param rawData - JSON Metasys data
 * @param conn - Active database connection
 * @returns { isAllReadingsOk, msgTotal }: isAllReadingsOk is true if everything loaded, 
 *   and msgTotal has the messages from parsing or loading. Errors are caught and returned 
 *   this way, not thrown.
 */
async function loadJCReadings(meter, rawData, conn) {
    const prefix = jcLogPrefix(meter.name);  // configure the prefix for logging this meter's data

    log.info('JC Started parsing data');

    try {
        // process the rawData into an object that contains errors, warnings, and readings
        const parseResult = parseJCMeterData(rawData, meter);

        // the existence of parsing errors mean there is nothing valid to load so report failure 
        // instead of loading no readings. (parseJCMeterData() exits on error)
        if (parseResult.errors.length > 0) {
            return {
                isAllReadingsOk: false,
                msgTotal: parseResult.errors.join('; ')
            };
        }

        // log the warnings for this meter, if any
        if (parseResult.warnings.length > 0) {
            log.warn(
                `${prefix} Parsing warnings: ${parseResult.warnings.join('; ')}`
            );
        }

        // log that we found readings and are starting to load them into the database.
        // included in the log are all the readings
        log.info(
            `${prefix} Readings being sent to loadArrayInput: ${JSON.stringify(parseResult.readings)}`
        );

        // attempt to load the data that was parsed by parseJCMeterData, for this meter
        return await loadArrayInput(
            parseResult.readings,
            meter.id,
            row => [row[0], row[1]],
            'increasing', // timeSort
            1, // readingRepetition
            true, // isCumulative
            false, // cumulativeReset
            '00:00:00', // cumulativeResetStart
            '23:59:59', // cumulativeResetEnd
            0, // readingGap
            0, // readingLengthVariation
            true, // isEndOnly
            true, // shouldUpdate
            {
                minVal: meter.minVal,
                maxVal: meter.maxVal,
                minDate: meter.minDate,
                maxDate: meter.maxDate,
                threshold: 0,
                // TODO - Discuss - honor meter value
                maxError: meter.maxError,
                disableChecks: 'reject_none'
            },
            conn,
            true, // honorDst
            false, // relaxedParsing
            true, // useMeterZone
            false // warnOnCumulativeReset
        );
    } catch (err) {
        // catch an error thrown by LoadArrayInput() and log it.
        log.error(
            `${prefix} Error in loadJCReadings for meter ${meter.name} (ID: ${meter.id}): ${err.message}`
        );
        // return from this function with an error indicated by isAllReadingsOk
        return {
            isAllReadingsOk: false,
            msgTotal: err.message
        };
    }
}

module.exports = {
    parseJCMeterData,
    loadJCReadings
};