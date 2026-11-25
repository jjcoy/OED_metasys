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
const { nextMeterStartDate } = require('../../util/readingsUtils.js')
// Not used while the meters are processed in sequence. See the TODO in updateJCMeters().
// const updateMeters = require('../updateMeters.js');
const { jcLogPrefix } = require('./jcCommon.js');
const { readJCData } = require('./readJCData.js');

// TODO moment has an interval object that might be better than the JSON returned by this function. Note super important.
/**
 * Returns the desired next reading acquisition date range for the provided meter.
 * The start date returned should allow acquiring all readings since the latest reading
 * for this meter that OED already has. The end date is the current time to get the meter's
 * readings up to the current time. Both times are UTC and in ISO format.
 * @param {Meter} meter The desired meter to get the next readings for.
 * @returns Desired { startDate, endDate} for the provided meter for next acquisition request.
 */
async function buildDateRangeRequest(meter) {
	// Gets the start date where it will be a special date (moment() as UTC) if the meter has
	// no readings yet. This is fine as Metasys will start at the first date for a reading it
	// has for this meter point. The second argument means OED needs the previous reading because
	// Metasys is cumulative & end only. The third argument means the returned date is shifted
	// a little forward in time because Metasys is end only and don't want the previous point
	// with that end time. The fourth argument means the requested time is not in the meter's
	// time zone as Metasys uses UTC. Note startDate is a moment object.
	// TODO It may be the case that the time being used is shifting wrong????????
	// let startDate = await nextMeterStartDate(meter, true, true, false);
	let startDate = await nextMeterStartDate(meter, true, true, true);
	// Convert to an ISO format.
	startDate = startDate.toISOString();
	// The end date is now converted to and ISO string.
	const endDate = moment().toISOString();
	return {
		startDate: startDate,
		endDate: endDate
	};
}

/**
 * Fetches and loads readings for all enabled Johnson Controls (Metasys) meters, then refreshes
 * the daily and hourly reading views if at least one meter loaded successfully.
 * Data comes from the Metasys API, or from the file in JC_FILE when JC_USE_API=false (see getMeterData in readJCData.js).
 * Errors are logged rather than thrown.
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

	try {
		// Retrieve all meters marked as enabled in the database
		const allMeters = await Meter.getEnabled(conn);

		// Narrow the list down to only Johnson Controls (Metasys) meter types
		const metersToUpdate = allMeters.filter(m => m.type === Meter.type.METASYS);
		// TODO Check that the code below behaves as desired if there are no meters to read.
		if (metersToUpdate.length === 0) {
			log.info(`${jcLogPrefix()} No enabled Metasys meters found`);
		}

		// Records each meter's outcome (success or failure) in results. readJCData catches its own
		// errors, so updateMeters() (when used) would not see them and they have to be recorded here.
		const reader = async (meter, meterConn) => {
			// Each meter can have its own date range depending on the last successful attempt to get
			// data for that meter.
			const dateRange = await buildDateRangeRequest(meter);
			results.push(await readJCData(meter, meterConn, dateRange));
		};

		// TODO Whether meter requests should be made in parallel or in series is being considered for
		// a future revision of OED. For now, they are made in series (see below).
		// updateMeters uses Promise.all to do all meters at once.
		// await updateMeters(reader, metersToUpdate, conn);

		// Process the meters one at a time so the same system is not hit in parallel
		log.info(`${jcLogPrefix()} Getting meter data for ${metersToUpdate.length} meter(s) in sequence`);
		for (const meter of metersToUpdate) {
			log.info(`${jcLogPrefix()} Start getting Metasys meter data for ${meter.name}`);
			await reader(meter, conn);
			log.info(`${jcLogPrefix()} End getting Metasys meter data for ${meter.name}`);
		}
		log.info(`${jcLogPrefix()} Update finished`);

		// TODO The upcoming version of OED is fusing the update of readings.
		// Furthermore, a planned release, maybe after that, is removing the need for the update
		// of readings. Thus, this will need to be updated later.
		// Only refresh the aggregated daily and hourly readings if something new was loaded
		// TODO See loadJCReadings() on the isAllReadingsOk value returned. Right now only okay to see if
		// should refresh readings as the value was set true when the pipeline returns false when
		// that seems safe.
		if (results.some(r => r.isAllReadingsOk)) {
			await refreshDailyReadings(conn);
			await refreshHourlyReadings(conn);
		}
	} catch (err) {
		log.error(`${jcLogPrefix()} Error getting the Metasys meters or refreshing the readings: ${err}`, err);
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
