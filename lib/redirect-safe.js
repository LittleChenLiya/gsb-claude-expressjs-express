/*!
 * express
 * Copyright(c) 2009-2013 TJ Holowaychuk
 * Copyright(c) 2014-2015 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict';

/**
 * Module dependencies.
 * @private
 */

var createError = require('http-errors');

/**
 * Fixed error code attached to rejected redirect targets.
 * @public
 */
var REDIRECT_REJECTED_CODE = 'ERR_REDIRECT_TARGET_REJECTED';

/**
 * Maximum number of percent-decoding passes applied when scanning a
 * target for hidden control characters. This bound keeps the check
 * finite: double-encoded sequences such as `%250D` are unwrapped, but
 * the target is never decoded in an unbounded loop.
 * @private
 */
var MAX_DECODE_PASSES = 3;

/**
 * Control characters that are never acceptable in a redirect target,
 * either literally or behind percent-encoding.
 * @private
 */
var CONTROL_CHARS_REGEXP = /[\x00-\x1f\x7f]/;

/**
 * Backslash is rejected because some agents treat it as a path
 * separator, which can turn a same-origin path into an authority
 * component (e.g. `https://trusted\\@evil.example`).
 * @private
 */
var BACKSLASH_REGEXP = /\\/;

/**
 * Normalize a configured origin string to its canonical
 * `scheme://host[:port]` form.
 *
 * Throws a TypeError when the configuration is invalid; this happens
 * before any response is generated.
 *
 * @param {String} value
 * @param {String} field
 * @return {String}
 * @private
 */
function normalizeOrigin (value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('redirectSafe policy "' + field + '" must be a non-empty origin string');
  }

  var url;
  try {
    url = new URL(value);
  } catch (e) {
    throw new TypeError('redirectSafe policy "' + field + '" is not a valid origin: ' + value);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('redirectSafe policy "' + field + '" must use http or https: ' + value);
  }

  if (url.username !== '' || url.password !== '') {
    throw new TypeError('redirectSafe policy "' + field + '" must not contain userinfo: ' + value);
  }

  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new TypeError('redirectSafe policy "' + field + '" must be a bare origin (no path, query or fragment): ' + value);
  }

  return url.origin;
}

/**
 * Create the rejection error for a target that fails the policy.
 *
 * @param {String} reason
 * @return {Error}
 * @private
 */
function rejectedError (reason) {
  var err = createError(400, 'redirect target rejected: ' + reason);
  err.code = REDIRECT_REJECTED_CODE;
  return err;
}

/**
 * Resolve and validate a redirect target against an explicit policy.
 *
 * The policy is intentionally restrictive:
 *
 * - `policy.baseOrigin` (required) is the trusted origin of this
 *   application. Same-origin absolute paths and relative references
 *   are resolved against it, using the path portion of the current
 *   `req.originalUrl` as the base for relative references. Query
 *   strings and fragments of the target are preserved.
 * - `policy.allowedOrigins` (optional) is an exact set of additional
 *   external origins. An external target only matches when the
 *   normalized protocol, host and port are all identical to a listed
 *   origin; non-default ports are significant and Unicode domains are
 *   compared in their ASCII (punycode) form.
 *
 * Trust is never derived from the incoming `Host` or
 * `X-Forwarded-Host` headers. Targets containing userinfo, backslashes,
 * network-path references, control characters or (possibly encoded)
 * CR/LF are rejected, as is anything outside the http/https protocols.
 * Percent-encoding is unwrapped with a bounded number of passes.
 *
 * Note that this only constrains where the redirect points; it does
 * not and cannot vouch for the content served by an allowed target.
 *
 * Returns the canonical URL string to send, or throws an error with
 * `code === 'ERR_REDIRECT_TARGET_REJECTED'` when the target is
 * rejected. Policy misconfiguration throws a TypeError instead.
 *
 * @param {IncomingMessage} req
 * @param {String} target
 * @param {Object} policy
 * @return {String}
 * @private
 */
function resolveRedirectTarget (req, target, policy) {
  if (policy == null || typeof policy !== 'object') {
    throw new TypeError('redirectSafe requires an explicit policy object with a "baseOrigin"');
  }

  var allowedOrigins = {};
  var baseOrigin = normalizeOrigin(policy.baseOrigin, 'baseOrigin');
  allowedOrigins[baseOrigin] = true;

  var extra = policy.allowedOrigins;
  if (extra !== undefined) {
    if (!Array.isArray(extra)) {
      throw new TypeError('redirectSafe policy "allowedOrigins" must be an array of origin strings');
    }
    for (var i = 0; i < extra.length; i++) {
      allowedOrigins[normalizeOrigin(extra[i], 'allowedOrigins[' + i + ']')] = true;
    }
  }

  if (typeof target !== 'string' || target.length === 0) {
    throw rejectedError('target must be a non-empty string');
  }

  if (CONTROL_CHARS_REGEXP.test(target)) {
    throw rejectedError('target contains control characters');
  }

  if (BACKSLASH_REGEXP.test(target)) {
    throw rejectedError('target contains a backslash');
  }

  if (target.charCodeAt(0) === 47 && target.charCodeAt(1) === 47) {
    throw rejectedError('network-path references are not allowed');
  }

  // Bounded unwrapping of nested percent-encoding to catch hidden
  // control characters (e.g. `%250D%250A`) without decoding forever.
  var layer = target;
  for (var pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    var unwrapped = layer.replace(/%([0-9A-Fa-f]{2})/g, function (match, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    });
    if (CONTROL_CHARS_REGEXP.test(unwrapped)) {
      throw rejectedError('target contains percent-encoded control characters');
    }
    if (BACKSLASH_REGEXP.test(unwrapped)) {
      throw rejectedError('target contains a percent-encoded backslash');
    }
    if (unwrapped === layer) {
      break;
    }
    layer = unwrapped;
  }

  var base;
  try {
    base = new URL(typeof req.originalUrl === 'string' ? req.originalUrl : '/', baseOrigin);
  } catch (e) {
    base = new URL(baseOrigin);
  }

  var url;
  try {
    url = new URL(target, base);
  } catch (e) {
    throw rejectedError('target cannot be parsed as a URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw rejectedError('only http and https targets are allowed');
  }

  if (url.username !== '' || url.password !== '') {
    throw rejectedError('userinfo is not allowed in redirect targets');
  }

  if (!allowedOrigins[url.origin]) {
    throw rejectedError('origin "' + url.origin + '" is not in the allowed set');
  }

  return url.href;
}

/**
 * Module exports.
 * @public
 */
exports.resolveRedirectTarget = resolveRedirectTarget;
exports.REDIRECT_REJECTED_CODE = REDIRECT_REJECTED_CODE;
