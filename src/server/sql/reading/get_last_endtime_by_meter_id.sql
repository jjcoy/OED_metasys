/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

-- For the provided meter id (meterId) return the latest end_timestamp for any
-- reading for that meter. It will return null if there are no readings for that meter.
SELECT
   MAX(readings.end_timestamp) as last_endtime
FROM readings
INNER JOIN meters ON meters.id = readings.meter_id
WHERE readings.meter_id = ${meterId}
;