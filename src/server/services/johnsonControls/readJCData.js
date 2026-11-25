/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const fs = require('fs');
const path = require('path');
const { log } = require('../../log.js');
const { jcLogPrefix } = require('./jcCommon.js');
const parseJC = require('./parseJCData.js');
const jcApi = require('./jcApiClient.js');

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
		// .replace(/\/+$/, '')
		baseUrl: `${url.origin}${url.pathname}`,
		username: url.searchParams.get('username'),
		password: url.searchParams.get('password'),
		fqr: url.searchParams.get('fqr')
		// TODO DEBUG This stops the request for data from happening
		// , skipRequest: true
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
 * Fetches meter data from a file containing the JSON response.
 * Throws if the file is not found or does not contain valid JSON.
 * @param filePath - path to a file with response
 * @returns Parsed JSON data
 */
async function fetchJCMeterDataFromFile(filePath) {
	const prefix = jcLogPrefix();
	const resolvedPath = path.resolve(filePath);

	// throw the error if the file is not found
	if (!fs.existsSync(resolvedPath)) {
		throw new Error(`File not found at path: ${resolvedPath}`);
	}

	// read the file all at once
	const rawText = await fs.promises.readFile(resolvedPath, 'utf-8');
	log.info(`${prefix} Successfully read data from file: ${resolvedPath}`);

	// parse the file's contents as a JSON object
	try {
		return JSON.parse(rawText);
	} catch (err) {
		throw new Error(
			`Failed to parse JSON from file ${resolvedPath}: ${err.message}`
		);
	}
}

/**
 * Get data for a meter. Live API by default, file (JC_FILE) only if JC_USE_API=false.
 * @param {Object} meter The OED meter to get readings for. Its url holds the Metasys connection information.
 * @param {string} startDate Start of the time range to get readings for, in ISO 8601 format
 * @param {string} endDate End of the time range to get readings for, in ISO 8601 format
 * @returns {Promise<Object>} The Metasys response as JSON, with the readings in its items array
 */
async function getMeterData(meter, startDate, endDate) {
	// if testing, read data from a file that is set as JC_FILE when jcTest.js is run
	if (process.env.JC_USE_API === 'false') {
		const filePath = process.env.JC_FILE;
		if (!filePath) {
			throw new Error('JC_FILE is not set');
		}

		log.info(`${jcLogPrefix(meter.name)} Reading from file: ${filePath}`);
		return fetchJCMeterDataFromFile(filePath);
	}
	// otherwise get data from the live Metasys API
	else {
		log.info(`${jcLogPrefix(meter.name)} Fetching from the Metasys API`);
		console.log('startDate, endDate: ', startDate, endDate);
		// Each meter has its own connection information so each one asks its own server for its own fqr.
		const credentials = getCredentialsFromMeter(meter);
		return jcApi.fetchJcMeterData(startDate, endDate, credentials);
	}
}

/**
 * Acquires JC readings for one OED meter and stores them in the database.
 * Errors are caught and returned so the caller can record a per-meter outcome.
 * @param {Object} meter The OED meter to get readings for
 * @param {Object} conn The database connection used to store the readings
 * @param {{ startDate: string, endDate: string }} dateRange ISO 8601 start and end of the readings to get
 * @returns {Promise<{ name: string, isAllReadingsOk: boolean, msgTotal: string }>}
 */
async function readJCData(meter, conn, dateRange) {
	try {
		// read data for this meter from the live API or a file
		const rawData = await getMeterData(meter, dateRange.startDate, dateRange.endDate);
		// TODO DEBUG
		console.log('readJCData, rawData: ', rawData);
		// process the raw data and load it into the database using loadJCReadings()
		const { isAllReadingsOk, msgTotal } = await parseJC.loadJCReadings(meter, rawData, conn);
		// check to see if there were errors and log results
		if (isAllReadingsOk) {
			log.info(`${jcLogPrefix(meter.name)} Successfully uploaded readings`);
		} else {
			log.error(`${jcLogPrefix(meter.name)} Failed to upload readings: ${msgTotal}`);
		}
		// return the outcome (isAllReadingsOk)
		return { name: meter.name, isAllReadingsOk, msgTotal };
	} catch (err) {
		// if a function called by getMeterData() threw an error, catch it and log it
		log.error(`${jcLogPrefix(meter.name)} Error processing meter: ${err.message}`, err);
		return { name: meter.name, isAllReadingsOk: false, msgTotal: err.message };
	}
}

module.exports = { readJCData, getMeterData, fetchJCMeterDataFromFile };
