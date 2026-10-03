/*!
 * express
 * Copyright(c) 2009-2013 TJ Holowaychuk
 * Copyright(c) 2013 Roman Shtylman
 * Copyright(c) 2014-2015 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict';

/**
 * Module dependencies.
 */

var createError = require('http-errors');
var parseurl = require('parseurl');

/**
 * A shared, frozen, read-only empty snapshot.
 *
 * It is safe to share between requests because it is immutable and
 * has a null prototype, so it can never be polluted.
 */

var EMPTY_SNAPSHOT = Object.freeze(Object.create(null));

/**
 * Strict query middleware.
 *
 * Parses the raw query string of the request URL into a read-only
 * snapshot exposed as req.strictQuery. The default req.query
 * parsing is left completely untouched.
 *
 * The raw query string is split on '&' (and the first '=' of each
 * pair) before any decoding takes place. Each key and value is then
 * strictly percent-decoded: a literal '%' must always be followed
 * by two hexadecimal digits, the resulting byte sequence must be
 * valid UTF-8, and '+' is decoded as a space per the
 * application/x-www-form-urlencoded rules.
 *
 * Decoded key names must be unique: two raw keys that decode to the
 * same name (for example 'a' and '%61') are rejected. Bracket keys
 * such as 'a[b]' are kept as literal keys and never produce nested
 * objects. Special names such as '__proto__' are stored as ordinary
 * data and cannot alter the prototype of the snapshot.
 *
 * Any failure is reported with a 400 error before the downstream
 * handler is invoked. Error positions are always raw offsets into
 * the original query string, never offsets into the decoded string.
 *
 * @return {Function}
 * @public
 */

module.exports = function strictQuery() {
  return function strictQuery(req, res, next) {
    var raw = parseurl(req).query;

    if (raw === undefined || raw === null || raw === '') {
      defineSnapshot(req, EMPTY_SNAPSHOT);
      return next();
    }

    try {
      defineSnapshot(req, parseStrictQuery(raw));
    } catch (err) {
      return next(err);
    }

    next();
  };
};

/**
 * Define the read-only strictQuery snapshot on the request.
 *
 * @param {object} req
 * @param {object} snapshot
 * @private
 */

function defineSnapshot(req, snapshot) {
  Object.defineProperty(req, 'strictQuery', {
    value: snapshot,
    enumerable: true,
    configurable: true,
    writable: false
  });
}

/**
 * Parse a raw query string into a frozen, null-prototype object.
 *
 * @param {string} raw
 * @return {object}
 * @private
 */

function parseStrictQuery(raw) {
  var result = Object.create(null);
  var seen = Object.create(null);
  var segments = raw.split('&');
  var offset = 0;

  for (var i = 0; i < segments.length; i++) {
    var segment = segments[i];

    if (segment.length > 0) {
      var eq = segment.indexOf('=');
      var keyEnd = eq === -1 ? segment.length : eq;
      var valueStart = eq === -1 ? segment.length : eq + 1;

      var key = decodeComponent(raw, offset, offset + keyEnd);
      var value = decodeComponent(raw, offset + valueStart, offset + segment.length);

      if (key in seen) {
        throw duplicateKeyError(key, seen[key], offset);
      }

      seen[key] = offset;

      // defineProperty on a null-prototype object stores even
      // __proto__ as a plain own property.
      Object.defineProperty(result, key, {
        value: value,
        enumerable: true,
        configurable: true,
        writable: false
      });
    }

    // the '&' separator
    offset += segment.length + 1;
  }

  return Object.freeze(result);
}

/**
 * Strictly percent-decode a slice of the raw query string.
 *
 * Every '%' must be followed by two hex digits; '+' is decoded as a
 * space per form rules; everything else is copied as a byte using
 * the latin-1 mapping that Node's HTTP server applies to raw URL
 * characters. The resulting byte sequence is decoded as strict
 * UTF-8.
 *
 * @param {string} raw
 * @param {number} start
 * @param {number} end
 * @return {string}
 * @private
 */

function decodeComponent(raw, start, end) {
  var bytes = [];
  var positions = [];

  for (var i = start; i < end; ) {
    var code = raw.charCodeAt(i);

    if (code === 0x25 /* '%' */) {
      if (i + 2 >= end) {
        throw invalidEncodingError(i);
      }

      var hi = hexValue(raw.charCodeAt(i + 1));
      var lo = hexValue(raw.charCodeAt(i + 2));

      if (hi === -1 || lo === -1) {
        throw invalidEncodingError(i);
      }

      bytes.push((hi << 4) | lo);
      positions.push(i);
      i += 3;
    } else {
      // application/x-www-form-urlencoded: '+' means space
      bytes.push(code === 0x2B /* '+' */ ? 0x20 : code & 0xFF);
      positions.push(i);
      i++;
    }
  }

  return decodeUtf8(bytes, positions);
}

/**
 * Decode a byte sequence as strict UTF-8.
 *
 * @param {number[]} bytes
 * @param {number[]} positions raw query offset of every byte
 * @return {string}
 * @private
 */

function decodeUtf8(bytes, positions) {
  var out = '';
  var len = bytes.length;
  var i = 0;

  while (i < len) {
    var b = bytes[i];

    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
    } else if (b >= 0xC2 && b <= 0xDF) {
      if (!isContinuation(bytes[i + 1])) {
        throw invalidUtf8Error(positions[i]);
      }
      out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F));
      i += 2;
    } else if (b >= 0xE0 && b <= 0xEF) {
      if (!isContinuation(bytes[i + 1]) || !isContinuation(bytes[i + 2])) {
        throw invalidUtf8Error(positions[i]);
      }
      if (b === 0xE0 && (bytes[i + 1] & 0xE0) !== 0xA0) {
        throw invalidUtf8Error(positions[i]);
      }
      if (b === 0xED && (bytes[i + 1] & 0xE0) !== 0x80) {
        throw invalidUtf8Error(positions[i]);
      }
      out += String.fromCharCode(
        ((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)
      );
      i += 3;
    } else if (b >= 0xF0 && b <= 0xF4) {
      if (!isContinuation(bytes[i + 1]) || !isContinuation(bytes[i + 2]) ||
          !isContinuation(bytes[i + 3])) {
        throw invalidUtf8Error(positions[i]);
      }
      if (b === 0xF0 && (bytes[i + 1] & 0xF0) !== 0x90) {
        throw invalidUtf8Error(positions[i]);
      }
      if (b === 0xF4 && (bytes[i + 1] & 0xF0) !== 0x80) {
        throw invalidUtf8Error(positions[i]);
      }
      var cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) |
               ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
      cp -= 0x10000;
      out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      i += 4;
    } else {
      // stray continuation byte (0x80-0xBF) or invalid lead byte (0xF5-0xFF)
      throw invalidUtf8Error(positions[i]);
    }
  }

  return out;
}

/**
 * Check for a UTF-8 continuation byte (0x80-0xBF).
 *
 * @param {number} b
 * @return {boolean}
 * @private
 */

function isContinuation(b) {
  return b >= 0x80 && b <= 0xBF;
}

/**
 * Convert a hexadecimal character to its nibble value.
 *
 * @param {number} code
 * @return {number} value or -1 when not a hex digit
 * @private
 */

function hexValue(code) {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;        // 0-9
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;  // a-f
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;  // A-F
  return -1;
}

/**
 * @param {number} position
 * @private
 */

function invalidEncodingError(position) {
  return createError(400, 'invalid percent-encoding at position ' + position, {
    code: 'STRICT_QUERY_INVALID_ENCODING',
    position: position
  });
}

/**
 * @param {number} position
 * @private
 */

function invalidUtf8Error(position) {
  return createError(400, 'invalid UTF-8 sequence at position ' + position, {
    code: 'STRICT_QUERY_INVALID_UTF8',
    position: position
  });
}

/**
 * @param {string} key
 * @param {number} firstPosition
 * @param {number} secondPosition
 * @private
 */

function duplicateKeyError(key, firstPosition, secondPosition) {
  return createError(400,
    'duplicate query parameter "' + key + '" at positions ' +
      firstPosition + ' and ' + secondPosition, {
      code: 'STRICT_QUERY_DUPLICATE',
      key: key,
      positions: [firstPosition, secondPosition]
    });
}
