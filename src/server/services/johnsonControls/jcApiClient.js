/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const axios = require('axios');
const rateLimit = require('axios-rate-limit');
const https = require('https');
const moment = require('moment');
const { log } = require('../../log');

/**
 * Configuration settings for the Metasys API connection
 * TODO These are temporary starting values to be changed when doing tests against a real metasys server
 * They will be removed and configs will be instead taken from user settable values in the dashboard
 * Real URL will look something like this:
 * https://metasys.example.com/api/v3?
 * username=admin
 * &password=1234
 * &fqr=TEST_FQR            // FQR = fully qualified reference
 * &attributeId=85          // make this a default value as it seems to be the default in the api docs
 * &pageSize=1000           // Metasys default value is 1000 so that can be left as a default value
 * &maxPages=10             // when the page loop hits 10 it will stop asking for data, null by default
 * &maxRequestsPerMinute=60 // 1 req/s
 */
const JC_CONFIG = Object.freeze({
    // baseUrl: 'https://<localhost:8000>/api/v3',
    // credentials: {
    // 	username: 'admin',
    // 	password: '123'
    // },
    // fqr: 'Metasys15_NAE-47_ModbusTCP',
    attributeId: 85,
    query: { pageSize: 50, sort: 'timestamp' },
    maxRequests: 1,
    perMilliseconds: 5000,
    timeout: 100000,
    maxPageSize: 50,
    maxPages: 2,
    maxDays: 7,
    maxSamples: 100,
    maxBytes: 25000,
    tokenRefreshSkew: 60000
});

/**
 * A HTTPS agent that allows connections to servers with a self-signed certificate, such as Metasys.
 * It is only used by jcHttp.
 * TODO - rejectUnauthorized: false turns off all TLS certificate verification (trust chain, expiry and hostname),
 * which is needed because Metasys uses a self-signed certificate.
 * A longer-term fix is to keep verification on and give the agent the Metasys server's own certificate
 * as a trusted 'ca', or to make rejectUnauthorized a setting that can differ per server.
 */
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

/**
 * A rate limited axios instance
 * We limit the maximum requests made to the server through the ratelimit package which
 * queues the requests. All requests use the HTTPS agent above (see the comment there about
 * certificate verification).
 */
const jcHttp = rateLimit(axios.create({
    httpsAgent: agent,
    timeout: JC_CONFIG.timeout,
    maxContentLength: JC_CONFIG.maxBytes,
    maxBodyLength: JC_CONFIG.maxBytes
}), {
    limits: [{
        maxRequests: JC_CONFIG.maxRequests,
        duration: `${JC_CONFIG.perMilliseconds}ms`
    }]
});

/**
 * The token cache to reuse the token before it expires
 * Object.seal prevents properties from being added or removed, but the existing values can still change.
 * TODO - This holds a single token for the whole process. It works when every JC meter uses the same Metasys
 * server and login. If meters use different servers or usernames (each meter's url has its own connection
 * information), a token from one server could be reused for another. Key the cache by baseUrl and username
 * (for example a Map) and check/store the token in getJcToken() using that key.
 */
const tokenCache = Object.seal({ token: undefined, expiresAt: 0 });

/**
 * TODO
 * Restrict date range during the testing phase
 * @param startTime start time
 * @param endTime end time
 * @returns nothing; throws an error if the dates are invalid or out of range
 */
function restrictDateRange(startTime, endTime) {
    const start = moment(startTime, moment.ISO_8601, true);
    const end = moment(endTime, moment.ISO_8601, true);

    // verify times are valid
    if (!start.isValid() || !end.isValid()) {
        return logAndError(`Invalid start or end time. Start: ${startTime}, End: ${endTime}`);
    }
    if (!end.isAfter(start)) {
        return logAndError(`End time must be after start time. Start: ${start}, End: ${end}`);
    }

    // limit the number of days being requested to what is defined in the JC_CONFIG object
    const days = moment.duration(end.diff(start)).asDays();
    if (days > JC_CONFIG.maxDays) {
        return logAndError(`Date range ${days} exceed max value: ${JC_CONFIG.maxDays}`);
    }

    log.info('JC range limit test passed');
}

/**
 * Log an error message and throw error so everything stops
 * @param message error message
 */
function logAndError(message) {
    log.error(`JC ${message}`);
    throw new Error(`JC ${message}`);
}

/**
 * Convert the expires time from ISO 8601 to ms
 * @param expires Time in ISO 8601
 * @returns time in ms; throws an error if expires is missing or invalid
 */
function parseExpires(expires) {
    if (!expires) {
        return logAndError('No expire value was provided to parse');
    }

    // convert to the proper format and check validity
    const parsed = moment(expires, moment.ISO_8601, true);
    if (!parsed.isValid()) {
        return logAndError(`expires parsed value is invalid: ${expires}`);
    }

    // return converted expiration time
    return parsed.valueOf();
}

/**
 * Header for authentication requests
 * @param token token
 * @returns auth header to authenticate
 */
function authHeader(token) {
    // return a dictionary with the standard header containing the token
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
    };
}

/**
 * Make a login request to Metasys, receive the access token in return
 * @param baseUrl metasys baseurl
 * @param username username
 * @param password password
 * @returns access token and expires time in ms
 */
async function jcLogin(baseUrl, username, password) {
    log.info('JC starting login request.');

    // connect to the server through the jcHttp rate limited axios instance
    const response = await jcHttp.post(`${baseUrl}/login`,
        {
            username,
            password
        },
        {
            headers: { 'Content-Type': 'application/json' }
        }
    ).catch(error => {
        return logAndError(`login failed. Error: ${error}`);
    });

    // parse and save received response, which should include the token if successful
    const data = response.data;
    const token = data && data.accessToken;
    if (!token) {
        logAndError('login token was not returned.');
    }

    // Metasys returns the expiration value in ISO 8601
    const expiresAt = parseExpires(data.expires);

    // log success and return token and expiration time
    log.info('JC successful login.');
    return { token, expiresAt };
}

/**
 * Check the token cache to retrieve a token to reuse, or if that token will expire too soon,
 * log in again to get a new token.
 * @param baseUrl metasys baseurl
 * @param username username
 * @param password password
 * @returns token
 */
async function getJcToken(baseUrl, username, password) {
    // Reuse the cached token only if it has more than the limit specified in JC_CONFIG left, so it does not expire in the middle of a request
    if (tokenCache.token && Date.now() < (tokenCache.expiresAt - JC_CONFIG.tokenRefreshSkew)) {
        log.info('JC reusing existing token');
        return tokenCache.token;
    }
    // otherwise, for the case that the token does not exist or will expire too soon, get a new one
    else {
        // get a new token
        const { token, expiresAt } = await jcLogin(baseUrl, username, password);
        // save it for later, then return the token
        tokenCache.token = token;
        tokenCache.expiresAt = expiresAt;
        return token;
    }
}

/**
 * Contact the Metasys server to retrieve a UUID for a given FQR
 * @param token token
 * @param baseUrl metasys baseurl
 * @param fqr fqr = fully qualified reference
 * @returns uuid
 */
async function getObjectUuid(token, baseUrl, fqr) {
    const uri = `${baseUrl}/objectIdentifiers?fqr=${fqr}`;

    // connect to the Metasys server with the request including the FQR
    const response = await jcHttp.get(uri, {
        headers: authHeader(token)
    }).catch(error => {
        return logAndError(`getObjectUuid failed. Error: ${error}`);
    });

    // parse the response, which should include the uuid as a string
    const data = response.data;
    if (typeof data === 'string' && data.length > 0) {
        return data;
    } else {
        return logAndError(`getObjectUuid returned no uuid for ${fqr}`);
    }
}

/**
 * Build the Metasys URI for retrieving one page of the data for a particular meter, given its UUID.
 * The data is limited to the start and end time given. Metasys may need more than one page to
 * return all the data in that time range, so this is called once per page.
 * @param baseUrl metasys baseurl
 * @param uuid uuid
 * @param startTime start time
 * @param endTime end time
 * @param page page number
 * @returns the URI to request this page of the meter's samples (readings); throws an error if the page size exceeds the max
 */
function buildMetasysUri(baseUrl, uuid, startTime, endTime, page) {
    // check that we have not exceeded our page size limits in JC_CONFIG
    if (JC_CONFIG.query.pageSize > JC_CONFIG.maxPageSize) {
        return logAndError(`page size exceeded max page size. Size: ${JC_CONFIG.query.pageSize}`);
    }

    // build the search parameters using the standard JavaScript URLSearchParams class
    const params = new URLSearchParams({
        startTime: startTime,
        endTime: endTime,
        page: page,
        pageSize: JC_CONFIG.query.pageSize,
        sort: JC_CONFIG.query.sort
    });

    // assemble and return the string for the URI
    return `${baseUrl}/objects/${uuid}/attributes/${JC_CONFIG.attributeId}/samples?${params}`;
}

/**
 * Fetch meter data for one particular meter from a Metasys server,
 * using the meter's FQR.  A login is not needed beforehand. getJcToken reuses a cached
 * token or logs in when needed.
 * TODO: check to see if we want this auto-login behavior.
 * @param startTime start time
 * @param endTime end time
 * @param credentials { baseUrl, username, password, fqr }
 * @returns metasys response data with all pages merged into one response
 */
async function fetchJcMeterData(startTime, endTime, credentials) {
    const baseUrl = credentials.baseUrl;
    const username = credentials.username;
    const password = credentials.password;
    // this is the meter we want to get this time
    const fqr = credentials.fqr;

    // TODO testing guard, will throw and exit if range exceeds requirements.
    // This limit may need to be raised or removed so the first request for a meter with no
    // readings does not fail.
    restrictDateRange(startTime, endTime);

    // record the current time as the start time to measure how long the whole fetch takes
    const logStart = moment();
    log.info('JC starting to fetch data');

    // retrieve a stored token with sufficient time remaining before expiration,
    // or get a new token from the server
    const token = await getJcToken(baseUrl, username, password);
    // we need to then ask Metasys to look up the UUID based on the FQR
    const uuid = await getObjectUuid(token, baseUrl, fqr);

    // build the uri for the first request for this meter
    let page = 1;
    let uri = buildMetasysUri(baseUrl, uuid, startTime, endTime, page);
    let firstBody = null;
    // we will collect a multi-page response here
    const allItems = [];

    // Metasys will send us one page of data at a time, including a URI to use to request
    // additional pages, if any.  Here, we loop over all pages, up to our JC_CONFIG limit.
    // The uri will be null when we reach the end.
    while (uri) {
        // check we have not exceeded the maximum number of pages in JC_CONFIG
        if (page > JC_CONFIG.maxPages) {
            log.info(`Received ${allItems.length} readings in ${page - 1} pages before reaching the max pages limit`);
            return logAndError(`Exceeded max pages of ${JC_CONFIG.maxPages} pages`);
        }
        log.info(`page number request: ${page}`);

        // connect to the Metasys server through the rate-limited axios instance, using this URI
        const response = await jcHttp.get(uri, {
            headers: authHeader(token)
        }).catch(error => {
            return logAndError(`fetchJcMeterData failed. Error: ${error}`);
        });

        // parse the response
        const body = response.data;
        // a missing body, or items that are not an array, is an error
        if (!body || !Array.isArray(body.items)) {
            log.info(`Readings at this point: ${JSON.stringify(allItems)}`);
            return logAndError('Response has no items in array');
        }

        // add this page's items to the collected response so far (allItems)
        allItems.push(...body.items);
        // check to see if we've exceeded our limit in JC_CONFIG, if so, we will stop now
        if (allItems.length > JC_CONFIG.maxSamples) {
            log.info(`Readings at this point: ${JSON.stringify(allItems)}`);
            return logAndError(`Readings have ${allItems.length} values which exceeded the max samples length of ${JC_CONFIG.maxSamples}`);
        }

        // DEBUG
        log.info(`Readings size at this point: ${allItems.length}`);

        // keep the first page's metadata (self, previous, total, attribute, objectUrl)
        // to describe the merged result when the function exits
        if (page === 1) {
            firstBody = body;
        }

        // if the Metasys server has more data, it will give us a link to the next page in body.next
        uri = body.next ? body.next : null;
        // increase the page count
        page += 1;
    }

    // we have finished gathering all the pages of the response; log the time it took
    const logEnd = moment().diff(logStart) / 1000;
    log.info(
        `JC got ${allItems.length} samples over ${page - 1} pages for fqr ${fqr} in ${logEnd} seconds`
    );

    // Warn if the number of samples received does not match the total Metasys reported
    if (firstBody.total !== undefined && firstBody.total !== allItems.length) {
        log.warn(`JC expected ${firstBody.total} samples but received ${allItems.length} for fqr ${fqr}`);
    }

    // Return the response as a dictionary with all pages merged into one,
    // including the metadata from the first page response, except for the next: field
    // which is set to null.
    // Note that the self entry is still the URI of the first request (page=1 and our
    // original, smaller pageSize), so this does not exactly represent a single large page.
    return { ...firstBody, next: null, items: allItems };
}

module.exports = {
    jcLogin,
    authHeader,
    getObjectUuid,
    buildMetasysUri,
    fetchJcMeterData
};