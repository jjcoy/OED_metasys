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

mocha.describe('nextMeterStartDate utility', () => {
	mocha.describe('no readings', () => {
		mocha.it('default parameters', async () => {
			const conn = testDB.getConnection();
			// A very simple meter for testing.
			const meterData = [
				{
					name: 'test',
					note: 'special meter',
					// TODO It may be the case the OED is going to add the ability not to have a file so an empty file is not needed.
					file: 'test/web/util/empty.csv',
					deleteFile: false,
					readingFrequency: '15 minutes',
					// Note the meter ID is set so we know what to expect when a query is made.
					id: METER_ID
				}
			];
			await insertMeters(meterData, conn);
			// Get meter just inserted.
			const meter = await Meter.getByID(METER_ID, conn);
			// Use default values where can.
			const returnDate = await nextMeterStartDate(meter);
			// The value should be moment(0) since no readings.
			expect(returnDate.isSame(moment(0))).to.equal(true);
		});
	});
});
