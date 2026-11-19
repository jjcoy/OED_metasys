/*
* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this
* file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/

const { expect, mocha } = require('../common');
const moment = require('moment');
const { testDB } = require('../commonTestDB');
const Meter = require('../../models/Meter');
const { nextMeterStartDate } = require('../../util/readingsUtils');
const { insertMeters } = require('../../util/insertData');
const { METER_ID } = require('../../util/readingsTestUtils');

// Accepts a moment object and return a string to represent it.
function formatMoment(datetime) {
	// Make the string include 5 decimal places in seconds so accurate enough.
	return datetime.utc().format('YYYY-MM-DD_HH:mm:ss.SSSSS');
}

// Changes the provided meter's end timestamp to arbitrary value.
function changeMeterEndtime(meter, conn) {
	// For it to make a change, need the meter's endTimestamp to differ from the actual reading.
	// Important that differs from endDate. Could calculate to keep in sync but doing it the simple way.
	meter.endTimestamp = '2021-01-03 00:00:00';
	meter.update(conn);
}

mocha.describe('nextMeterStartDate utility', () => {
	// The default initial time for some meter values.
	const E0 = moment(0).utc();
	// Shift used in function in seconds. This needs to match what the code uses.
	const shift = 0.01;
	let conn;
	mocha.describe('no readings', () => {
		let meter;
		mocha.beforeEach(async () => {
			conn = testDB.getConnection();
			// A very simple meter for testing with no readings.
			const meterData = [
				{
					name: 'testEmpty',
					// Arbitrary time zone to see if it is okay.
					meterTimezone: 'Etc/GMT-5',
					note: 'special meter with no readings',
					// TODO It may be the case the OED is going to add the ability not to have a file so an empty file is not needed.
					file: 'test/util/readingsEmpty.csv',
					deleteFile: false,
					readingFrequency: '15 minutes',
					// Note the meter ID is set so we know what to expect when a query is made.
					id: METER_ID
				}
			];
			await insertMeters(meterData, conn);
			// Get meter just inserted.
			meter = await Meter.getByID(METER_ID, conn);
		});
		mocha.it('default parameters', async () => {
			const returnDate = await nextMeterStartDate(meter);
			// The value should be moment(0) since no readings.
			expect(formatMoment(returnDate)).to.equal(formatMoment(E0));
		});
		mocha.it('needPrevious true', async () => {
			const returnDate = await nextMeterStartDate(meter, true);
			// The value should be moment(0) since no readings. needPrevious should not change date.
			expect(formatMoment(returnDate)).to.equal(formatMoment(E0));
		});
		mocha.it('shiftDate true', async () => {
			const returnDate = await nextMeterStartDate(meter, undefined, true);
			// The value should be moment(0) since no readings. shiftDate should not change date.
			expect(formatMoment(returnDate)).to.equal(formatMoment(E0));
		});
		mocha.it('putInMeterTz true', async () => {
			const returnDate = await nextMeterStartDate(meter, undefined, undefined, true);
			// The value should be moment(0) since no readings. putInMeterTz should not change date.
			expect(formatMoment(returnDate)).to.equal(formatMoment(E0));
		});
		mocha.it('needPrevious & shiftDate true', async () => {
			const returnDate = await nextMeterStartDate(meter, true, true);
			// The value should be moment(0) since no readings. needPrevious & shiftDate should not change date.
			expect(formatMoment(returnDate)).to.equal(formatMoment(E0));
		});
	});
	mocha.describe('1 reading', () => {
		let meter, endDate, meterFrequency;
		mocha.beforeEach(async () => {
			conn = testDB.getConnection();
			// This must match the one end date in the CSV file.
			endDate = moment.utc('2021-02-03 14:30:00');
			meterFrequency = '15';
			// A very simple meter for testing where has one reading loaded.
			const meterData = [
				{
					name: 'testOne',
					meterTimezone: 'Etc/GMT-5',
					note: 'special meter with one reading',
					file: 'test/util/readingsOne.csv',
					deleteFile: false,
					readingFrequency: meterFrequency + ' minutes',
					endTimestamp: formatMoment(endDate),
					// Note the meter ID is set so we know what to expect when a query is made.
					id: METER_ID
				}
			];
			await insertMeters(meterData, conn);
			// Get meter just inserted.
			meter = await Meter.getByID(METER_ID, conn);
		});
		mocha.it('default parameters', async () => {
			const returnDate = await nextMeterStartDate(meter);
			// For reasons that are unclear, comparing these two moment objects with .isSame returns false.
			// Printing them out seems to show the same thing so it probably is something internal.
			// As a result, using the formatted strings to compare. An advantage is that if it fails you see
			// the strings instead of the boolean.
			// This type of test is used everywhere to be consistent even thought E0 test worked with isSame.
			// Datetime shifted since shiftDate true by default.
			expect(formatMoment(returnDate)).to.equal(formatMoment(endDate.clone().add(shift, 'seconds')));
		});
		mocha.it('needPrevious true', async () => {
			// For it to make a change, need the meter's endTimestamp to differ from the actual reading.
			changeMeterEndtime(meter, conn)
			const returnDate = await nextMeterStartDate(meter, true);
			// Move date back in time and also include default shift.
			const desired = endDate.clone().subtract(meterFrequency * 1.5, 'minutes').add(shift, 'seconds');
			expect(formatMoment(returnDate)).to.equal(formatMoment(desired));
		});
		// TODO The above test does not check the logging is correct. Should also check log when the endTimestamp.
		// differs but not needPrevious.
		mocha.it('shiftDate false', async () => {
			const returnDate = await nextMeterStartDate(meter, undefined, false);
			expect(formatMoment(returnDate)).to.equal(formatMoment(endDate));
		});
		mocha.it('putInMeterTz true', async () => {
			const returnDate = await nextMeterStartDate(meter, undefined, undefined, true);
			// Apply shift & put in meter time zone.
			const desired = endDate.clone().add(shift, 'seconds').tz(meter.meterTimezone, true)
			expect(formatMoment(returnDate)).to.equal(formatMoment(desired));
		});
		mocha.it('needPrevious & shiftDate false', async () => {
			const returnDate = await nextMeterStartDate(meter, false, false);
			expect(formatMoment(returnDate)).to.equal(formatMoment(endDate));
		});
		// TODO This does basic coverage but more combinations & tests could be added.
	});
});
