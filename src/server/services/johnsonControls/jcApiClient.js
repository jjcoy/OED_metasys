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
 * Real config URL in the dashboard will look something like this:
 * https://metasys.example.com/api/v3/config?
 * username=admin
 * &password=1234
 * &fqr=TEST_FQR
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
 * Log a error message and throw error so everything stops
 * @param message error message
 */
function logAndError(message) {
    log.error(`JC ${message}`);
    throw new Error(`JC ${message}`);
}

/**
 * TEMP
 * Restrict date range during the testing phase
 * @param startTime start time
 * @param endTime end time
 * @returns void or error
 */
function restrictDateRange(startTime, endTime) {
    const start = moment(startTime, moment.ISO_8601, true);
    const end = moment(endTime, moment.ISO_8601, true);

    if (!start.isValid() || !end.isValid()) {
        return logAndError(`Invalid start or end time. Start: ${startTime}, End: ${endTime}`);
    }

    if (!end.isAfter(start)) {
        return logAndError(`End time must be after start time. Start: ${start}, End: ${end}`);
    }

    const days = moment.duration(end.diff(start)).asDays();
    if (days > JC_CONFIG.maxDays) {
        return logAndError(`Date range ${days} exceed max value: ${JC_CONFIG.maxDays}`);
    }

    log.info('JC range limit test passed');
}

/**
 * A rate limited axios instance
 * We limit the size of the data download through the build it axios values
 * We limit the maximum requests made to the server through the ratelimit package which queues the requests.
 */
const jcHttp = rateLimit(axios.create({
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
 * A HTTPS agent that allows connections to servers with a self-signed certificate
 */
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

/**
 * The token cache to reuse the token before it expires
 * Object.seal prevents any of the properties of the object from changing while the values can change
 */
const tokenCache = Object.seal({ token: undefined, expiresAt: 0 });

/**
 * Convert the expires time from ISO 8601 to ms
 * @param expires Time in ISO 8601
 * @returns error or time in ms
 */
function parseExpires(expires) {
    if (!expires) {
        return logAndError('No expire value was provied to parse');
    }

    const parsed = moment(expires, moment.ISO_8601, true);
    if (!parsed.isValid()) {
        return logAndError(`JC expires parsed value is invalid: ${expires}`);
    }

    return parsed.valueOf();
}

/**
 * Header for authentication requests
 * @param token token
 * @returns auth header to authenticate
 */
function authHeader(token) {
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
    };
}

/**
 * Make a login requst to Metasys
 * @param baseUrl metasys baseurl
 * @param username username
 * @param password password
 * @returns access token and expires time in ms
 */
async function jcLogin(baseUrl, username, password) {
    log.info('JC starting login request.');

    const response = await jcHttp.post(`${baseUrl}/login`,
        {
            username,
            password
        },
        {
            httpsAgent: agent,
            headers: { 'Content-Type': 'application/json' }
        }
    ).catch(error => {
        return logAndError(`JC login failed. Error: ${error}`);
    });

    const data = response.data;
    const token = data && data.accessToken;
    if (!token) {
        logAndError(`JC login token was not returned. Data: ${data}`);
    }

    // Metasys returns the expires value in ISO 8601
    const expiresAt = parseExpires(data.expires);

    log.info('JC successful login.');

    return { token, expiresAt };
}

/**
 * Get a token that can be used before it expires
 * @param baseUrl metasys baseurl
 * @param username username
 * @param password password
 * @returns token
 */
async function getJcToken(baseUrl, username, password) {
    // Make sure the token isn't going to expire soon so that it doesn't expire in the middle of a request
    if (tokenCache.token && Date.now() < (tokenCache.expiresAt - JC_CONFIG.tokenRefreshSkew)) {
        log.info('JC reusing existing token');
        return tokenCache.token;
    }

    const { token, expiresAt } = await jcLogin(baseUrl, username, password);
    tokenCache.token = token;
    tokenCache.expiresAt = expiresAt;

    return token;
}

/**
 * Get a UUID from a FQR
 * @param token token
 * @param baseUrl metasys baseurl
 * @param fqr fqr
 * @returns uuid
 */
async function getObjectUuid(token, baseUrl, fqr) {
    const uri = `${baseUrl}/objectIdentifiers?fqr=${fqr}`;
    // DEBUG
    // log.info(`uri: ${uri}, token: ${token}, authHeader(token): ${JSON.stringify(authHeader(token))}`);

    const response = await jcHttp.get(uri, {
        httpsAgent: agent,
        headers: authHeader(token)
    }).catch(error => {
        return logAndError(`JC getObjectUuid failed. Error: ${error}`);
    });

    const data = response.data;
    // Metasys returns a string as a response instead of any values wrapped in objects
    if (typeof data === 'string' && data.length > 0) {
        return data;
    } else {
        return logAndError(`JC getObjectUuid returned no uuid for ${fqr}`);
    }
}

/**
 * Build the Metasys URL
 * @param baseUrl metasys baseurl
 * @param uuid uuid
 * @param startTime start time
 * @param endTime end time
 * @param page page number
 * @returns error or sample url
 */
function buildSampleUri(baseUrl, uuid, startTime, endTime, page) {
    if (JC_CONFIG.query.pageSize > JC_CONFIG.maxPageSize) {
        return logAndError(`JC page size exceeded max page size. Size: ${JC_CONFIG.query.pageSize}`);
    }

    const params = new URLSearchParams({
        startTime: startTime,
        endTime: endTime,
        page: page,
        pageSize: JC_CONFIG.query.pageSize,
        sort: JC_CONFIG.query.sort
    });

    return `${baseUrl}/objects/${uuid}/attributes/${JC_CONFIG.attributeId}/samples?${params}`;
}

/**
 * Fetch meter data from a Metasys server
 * @param startTime start time
 * @param endTime end time
 * @param credentials { baseUrl, username, password, fqr }
 * @returns metasys response data
 */
async function fetchJcMeterData(startTime, endTime, credentials) {
    const baseUrl = credentials.baseUrl;
    const username = credentials.username;
    const password = credentials.password;
    const fqr = credentials.fqr;

    restrictDateRange(startTime, endTime);

    const logStart = moment();
    log.info('JC starting to fetch data');

    const token = await getJcToken(baseUrl, username, password);
    const uuid = await getObjectUuid(token, baseUrl, fqr);

    let uri = buildSampleUri(baseUrl, uuid, startTime, endTime, 1);
    let page = 1;
    let lastBody = null;
    const allItems = [];

    while (uri) {
        log.info(`page number request: ${page}`);
        if (page > JC_CONFIG.maxPages) {
            log.info(allItems);
            return logAndError(`Exceeded max pages of ${JC_CONFIG.maxPages} pages`);
        }

        const response = await jcHttp.get(uri, {
            httpsAgent: agent,
            headers: authHeader(token)
        }).catch(error => {
            return logAndError(`JC fetchJcMeterData failed. Error: ${error}`);
        });

        const body = response.data;
        if (!body || !Array.isArray(body.items)) {
            log.info(`Readings at this point: ${JSON.stringify(allItems)}`);
            return logAndError('Response has no items in array');
        }

        allItems.push(...body.items);
        if (allItems.length > JC_CONFIG.maxSamples) {
            log.info(`Readings at this point: ${JSON.stringify(allItems)}`);
            return logAndError(`Readings have ${allItems.length} values which exceeded the max samples length of ${JC_CONFIG.maxSamples}`);
        }
        // DEBUG
        log.info(`Readings size at this point: ${allItems.length}`);
        // log.info(`Readings at this point: ${JSON.stringify(allItems)}`);

        lastBody = body;
        uri = body.next ? body.next : null;
        page += 1;
    }

    const logEnd = moment().diff(logStart) / 1000;
    log.info(
        `JC got ${allItems.length} samples over ${page - 1} pages for fqr ${fqr} in ${logEnd} seconds`
    );

    // Return a response with all pages merged into one
    return { ...lastBody, items: allItems };
}

module.exports = {
    jcLogin,
    authHeader,
    getObjectUuid,
    buildSampleUri,
    fetchJcMeterData
};