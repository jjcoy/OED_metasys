/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Code shared by the Johnson Controls (Metasys) files.
 * It does not require any of the other JC files so any of them can use 
 * it without a circular import.
 */

/**
 * Returns a log prefix tag for JC meter log messages.
 * @param [meterName] - Optional meter name to include in the prefix
 * @returns Log prefix string
 */
function jcLogPrefix(meterName) {
    return meterName ? `[JC-${meterName}]` : '[JC]';
}

module.exports = { jcLogPrefix };
