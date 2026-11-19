/*
* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this
* file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/

const moment = require('moment');
const { getConnection } = require('../db');
const Reading = require('../models/Reading');
const { meterTimezone } = require('../services/meterTimezone');
const { log } = require('../log.js');

/**
 * For the provided meter, it returns the date as a moment object to use for the request
 * for that meter. The value is the adjusted latest reading endTimestamp for that meter.
 * If there is no readings for that meter then it will return a very early date
 * to indicate all readings should be acquired for that meter. This date is the
 * time of moment(0) which is the same as the previous time stamp on a new meter.
 * The adjusted latest reading is latest reading stored in OED for that meter. It is compared
 * to the end timestamp on the meter. If readings are input in time order then this should
 * be the same as the latest reading. If it isn't then the
 * request isn't in time order. This is an issue if OED needs the previous reading to set
 * the current one, i.e., end only and/or cumulative, where needPrevious is true. If that is
 * the case then OED backs up the date returned to try to get the previous reading. That is
 * not normally used (OED drops it) so it should not matter. If the shiftDate is true then
 * the returned date is shifted slightly earlier.
 * @param {Meter) meter The meter object for the meter desired.
 * @param {boolean} needPrevious If true then tries to return value (see above) so all readings are acquired. Default is false.
 * @param {boolean} shiftDate If true then shift returned date back by a small amount so earlier for systems that need that. Default is true.
 * @param {boolean} putInMeterTz If true then the returned date is in placed in the meter's time zone. The returned value will be UTC so a shift will occur when that happens. Default is false.
 * @returns {Promise<moment>} A moment object with the date.
 */
async function nextMeterStartDate(meter, needPrevious = false, shiftDate = true, putInMeterTz = false) {
	// TODO This needs to be rolled to other places such as eGauge.
	// This is the time stored when a meter is created and means no readings have yet been acquired.
	// It is needed when there are no readings on the provided meter.
	const E0 = moment(0).utc();
	// Establish a connection to the database.
	const conn = await getConnection();
	// Get the latest end timestamp for this meter.
	let returnDate = await Reading.getLastEndtimeByMeterId(meter.id, conn);
	if (returnDate === null) {
		// The meter has no readings so use the OED, early date. It is not shifted.
		returnDate = E0;
	} else {
		// The next reading has a start time that is near the the last reading's end time as
		// readings already exist.
		// OED stores the last reading on the meter as endTimestamp. This is being compared to
		// the last reading to see if they agree. If not, then these are seem out of time order
		// so OED will try to correct.
		// The meter endTimestamp is stored as a string so we need to parse and then convert to UTC.
		const endTimestampTz = moment.parseZone(meter.endTimestamp, true);
		// Note this modifies the endTimestampTz object.
		const lastTimestamp = moment.parseZone(endTimestampTz.tz('UTC', true));
		if (!lastTimestamp.isSame(returnDate)) {
			// They are not the same.
			// First, start a message to log it.
			let msg = `The lastTimestamp of ${lastTimestamp} is not the same as the last reading end date of ${returnDate} for meter ${meter.name}.`
			// Second, see if needPrevious is true.
			if (needPrevious) {
				// Want to start a reading before this time because the first reading sent will be dropped
				// in this case. To be safe, used 1.5x the meter frequency?? to shift the return date
				// back in time. Since OED usually drops duplicate readings, it will ignore any already
				// acquired at the small price of asking for another readings.
				const shift = meter.readingFrequency.asSeconds() * 1.5;
				returnDate = returnDate.clone().subtract(shift, 'seconds');
				msg += ` Since needPrevious is true, the returnDate was shifted back by ${shift.asMinutes} minutes to give a returnDate of ${returnDate}`;
			}
			// Log the complete message.
			log.warn(msg);
		}
		if (shiftDate) {
			// Some systems will return the reading with the given end date. This may esp. be
			// common if it is an end only system. If the date was from
			// the latest reading then it will be be the end date of the last readings.
			// To avoid getting that reading again, shift the return data forward.
			// To be general and safe, the start time is 0.01 seconds later.
			// This seems very safe since the frequency of getting data will never be that small.
			returnDate = returnDate.clone().add(0.01, 'seconds');
		}
		if (putInMeterTz) {
			// OED returns readings in UTC even though they are in the meter time zone reference
			// if that is used. So, must shift the time to UTC for the
			// next date/time request. Thus, make this in the meter time zone and then shift to UTC.
			// First determine the best guess of the meter time zone.
			const meterZone = await meterTimezone(meter);
			// Next change the date/time to be in the meter time zone without changing the date/time.
			// This keeps the time the same but applies the time zone.
			returnDate = returnDate.clone().tz(meterZone, true);
		}
		// Now put the time in UTC. If the caller wants a different time zone then a shift is needed
		// in that code. So far, systems have generally worked in UTC so returning that.
		returnDate = moment.utc(returnDate);
	}
	return returnDate;
}

module.exports = { nextMeterStartDate };
