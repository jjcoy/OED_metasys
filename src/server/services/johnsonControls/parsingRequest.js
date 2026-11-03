/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const loadArrayInput = require('../pipeline-in-progress/loadArrayInput.js');
const { log } = require('../../log.js');
const fs = require('fs');
const path = require('path');

/**
 * Returns a log prefix tag for JC meter log messages.
 * @param [meterName] - Optional meter name to include in the prefix
 * @returns Log prefix string
 */
function jcLogPrefix(meterName) {
    return meterName ? `[JC-${meterName}]` : '[JC]';
}

/**
 * Fetches meter data from a file containing the JSON response.
 * @param filePath - path to a file with response
 * @returns Parsed JSON data
 */
async function fetchJCMeterDataFromFile(filePath) {
    const prefix = jcLogPrefix();
    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`File not found at path: ${resolvedPath}`);
    }

    const rawText = await fs.promises.readFile(resolvedPath, 'utf-8');
    log.info(`${prefix} Successfully read data from file: ${resolvedPath}`);

    try {
        return JSON.parse(rawText);
    } catch (err) {
        throw new Error(
            `Failed to parse JSON from file ${resolvedPath}: ${err.message}`
        );
    }
}

/**
 * Parses raw JC meter data into OED-compatible readings.
 * @param rawData - Raw JSON response
 * @param meter - Meter object
 * @returns Parsed result object
 */
function parseJCMeterData(rawData, meter) {
    const prefix = jcLogPrefix(meter.name);
    const result = {
        readings: [],
        warnings: [],
        errors: []
    };

    if (!rawData || !Array.isArray(rawData.items)) {
        const msg = 'Invalid API response structure';
        result.errors.push(msg);
        log.error(`${prefix} ${msg}`);
        return result;
    }

    const jsonItems = rawData.items;

    if (jsonItems.length === 0) {
        const msg = `No data returned from the query for meter ${meter.name} (ID: ${meter.id})`;
        result.errors.push('No data returned from the query');
        log.error(`${prefix} ${msg}`);
        return result;
    }

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

    // Look into ?
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

    // Validate - log bad values
    result.readings = jsonItems
        .filter(it => it && it.value && typeof it.value.value === 'number')
        .map(it => [it.value.value, it.timestamp]);

    log.info(
        `${prefix} Parsed ${result.readings.length} valid readings from response`
    );

    return result;
}

/**
 * Processes meter readings and uploads them to the OED database.
 * @param meter - Meter
 * @param rawData - JSON Metasys data
 * @param conn - Active database connection
 * @returns Upload result
 */
async function loadJCReadings(meter, rawData, conn) {
    const prefix = jcLogPrefix(meter.name);

    log.info('JC Started parsing data');

    try {
        const parseResult = parseJCMeterData(rawData, meter);

        // Parse errors mean there is nothing valid to load so report failure instead of loading no readings
        if (parseResult.errors.length > 0) {
            return {
                isAllReadingsOk: false,
                msgTotal: parseResult.errors.join('; ')
            };
        }

        if (parseResult.warnings.length > 0) {
            log.warn(
                `${prefix} Parsing warnings: ${parseResult.warnings.join('; ')}`
            );
        }

        log.info(
            `${prefix} Readings being sent to loadArrayInput: ${JSON.stringify(parseResult.readings)}`
        );

        // Check if right number of arguments
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
        log.error(
            `${prefix} Error in jcMeterRequest for meter ${meter.name} (ID: ${meter.id}): ${err.message}`
        );
        return {
            isAllReadingsOk: false,
            msgTotal: err.message
        };
    }
}

module.exports = {
    jcLogPrefix,
    fetchJCMeterDataFromFile,
    parseJCMeterData,
    loadJCReadings
};