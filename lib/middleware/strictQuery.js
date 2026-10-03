/*!
 * express
 * Copyright(c) 2026 Express Contributors
 * MIT Licensed
 */

'use strict';

/**
 * Module dependencies.
 * @private
 */

var createError = require('http-errors');
var parseurl = require('parseurl');

/**
 * Module variables.
 * @private
 */

var EMPTY = Object.freeze(Object.create(null));

/**
 * Create a strict query-string parser middleware.
 *
 * The parsed result is stored on an independent property of the request
 * (default: `req.strictQuery`). The built-in `req.query` getter is never
 * touched and keeps its default ("simple") behavior.
 *
 * Rules:
 *  - the query component is split on `&` as it appears in the original URL
 *  - every key and value is strictly percent-decoded (byte by byte); a
 *    stray `%` or a byte sequence that is not valid UTF-8 is rejected
 *    with its raw (pre-decode) character offset
 *  - plus signs are decoded to spaces, following the explicit
 *    application/x-www-form-urlencoded form rule (set `options.plus` to
 *    "keep" to leave `+` untouched)
 *  - bracket keys such as `a[b]` are stored as literal keys; no nested
 *    objects or arrays are produced
 *  - two pairs that decode to the same key (for example `a` and `%61`)
 *    are rejected; the error reports the raw positions of both
 *    occurrences
 *  - `__proto__`, `constructor` and friends are stored as ordinary data
 *    and can never modify an object prototype
 *  - when there is no query component an empty, frozen, null-prototype
 *    snapshot is returned
 *
 * On any violation the request is rejected with a 400 error and the route
 * handler is never invoked.
 *
 * @param {Object} [options]
 * @param {String} [options.property='strictQuery'] request property to assign
 * @param {'space'|'keep'} [options.plus='space'] how to decode `+`
 * @return {Function} middleware
 * @public
 */

exports = module.exports = strictQuery;
exports.parse = parseStrictQuery;

function strictQuery(options) {
  var opts = options || {};
  var property = opts.property !== undefined ? opts.property : 'strictQuery';
  var plus = opts.plus !== undefined ? opts.plus : 'space';

  if (typeof property !== 'string' || property === '') {
    throw new TypeError('option property must be a non-empty string');
  }

  if (plus !== 'space' && plus !== 'keep') {
    throw new TypeError('option plus must be "space" or "keep"');
  }

  return function strictQueryParser(req, res, next) {
    var parsed = parseurl.original(req);
    var raw = parsed !== undefined && parsed.query !== null
      ? parsed.query
      : '';

    try {
      req[property] = parseStrictQuery(raw, { plus: plus });
    } catch (err) {
      req[property] = EMPTY;
      return next(createError(400, err.message, {
        code: err.code,
        position: err.position
      }));
    }

    next();
  };
}

/**
 * Strictly parse a raw query string.
 *
 * @param {String} raw the query component without the leading `?`
 * @param {Object} [options]
 * @param {'space'|'keep'} [options.plus='space']
 * @return {Object} frozen, null-prototype object of decoded key/value pairs
 * @public
 */

function parseStrictQuery(raw, options) {
  var opts = options || {};
  var plus = opts.plus !== undefined ? opts.plus : 'space';
  var string = raw || '';

  if (string === '') {
    return EMPTY;
  }

  // Phase 1: split on the raw '&' delimiters and strictly decode every
  // key/value pair. Encoding failures are reported here with raw offsets.
  var entries = [];
  var firstError = null;
  var start = 0;

  for (var index = 0; index <= string.length; index++) {
    if (index !== string.length && string.charCodeAt(index) !== 0x26 /* & */) {
      continue;
    }

    var pair = string.slice(start, index);

    if (pair !== '') {
      var equals = pair.indexOf('=');
      var rawKey = equals === -1 ? pair : pair.slice(0, equals);
      var rawValue = equals === -1 ? '' : pair.slice(equals + 1);
      var keyStart = start;
      var valueStart = equals === -1 ? index : start + equals + 1;

      var decodedKey = null;
      var decodedValue = null;
      var err = null;

      try {
        decodedKey = decodeComponent(rawKey, plus, keyStart);
      } catch (e) {
        err = e;
      }

      if (!err) {
        try {
          decodedValue = decodeComponent(rawValue, plus, valueStart);
        } catch (e) {
          err = e;
        }
      }

      if (err) {
        if (firstError === null || err.position < firstError.position) {
          firstError = err;
        }
      } else {
        entries.push({
          key: decodedKey,
          value: decodedValue,
          position: keyStart
        });
      }
    }

    start = index + 1;
  }

  if (firstError !== null) {
    throw firstError;
  }

  // Phase 2: detect duplicate decoded keys. Positions reported are the
  // raw offsets at which each occurrence starts in the query string.
  var seen = Object.create(null);

  for (var e = 0; e < entries.length; e++) {
    var name = entries[e].key;
    var pos = entries[e].position;

    if (Object.prototype.hasOwnProperty.call(seen, name)) {
      seen[name].push(pos);
    } else {
      seen[name] = [pos];
    }
  }

  var duplicateKey = null;
  var duplicateSecond = null;

  for (var keyName in seen) {
    if (seen[keyName].length > 1
      && (duplicateSecond === null || seen[keyName][1] < duplicateSecond)) {
      duplicateKey = keyName;
      duplicateSecond = seen[keyName][1];
    }
  }

  if (duplicateKey !== null) {
    throw queryError(
      'DUPLICATE_QUERY_KEY',
      'Duplicate query parameter "' + duplicateKey + '" at positions '
        + seen[duplicateKey].join(' and '),
      seen[duplicateKey][0]
    );
  }

  // Phase 3: build the result on a null prototype and define every key as
  // a non-writable data property. Names like "__proto__" can never touch
  // an object prototype this way.
  var result = Object.create(null);

  for (var r = 0; r < entries.length; r++) {
    Object.defineProperty(result, entries[r].key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: entries[r].value
    });
  }

  return Object.freeze(result);
}

/**
 * Strictly percent-decode one key or value.
 *
 * `+` is decoded as a space per the form rule unless `plus` is "keep".
 * The decoded bytes are validated as UTF-8. All error positions are
 * offsets into the raw query string (`base` is the offset at which this
 * component starts), never post-decode offsets.
 *
 * @param {String} input
 * @param {'space'|'keep'} plus
 * @param {Number} base
 * @return {String}
 * @private
 */

function decodeComponent(input, plus, base) {
  var bytes = [];
  var offsets = [];

  for (var i = 0; i < input.length; i++) {
    var high = input.charCodeAt(i);
    var code = high;
    var sourceOffset = base + i;

    if (high === 0x25 /* % */) {
      var a = hexValue(input.charCodeAt(i + 1));
      var b = hexValue(input.charCodeAt(i + 2));

      if (a < 0 || b < 0) {
        throw queryError(
          'MALFORMED_PERCENT_ENCODING',
          'Malformed percent-encoding at position ' + sourceOffset,
          sourceOffset
        );
      }

      bytes.push((a << 4) | b);
      offsets.push(sourceOffset);
      i += 2;
      continue;
    }

    if (high === 0x2B /* + */ && plus === 'space') {
      bytes.push(0x20);
      offsets.push(sourceOffset);
      continue;
    }

    if (high >= 0xD800 && high <= 0xDBFF && i + 1 < input.length) {
      var low = input.charCodeAt(i + 1);

      if (low >= 0xDC00 && low <= 0xDFFF) {
        code = 0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00);
        i++;
      }
    }

    if (code >= 0xDC00 && code <= 0xDFFF) {
      throw queryError(
        'INVALID_UTF8',
        'Invalid UTF-8 in query string at position ' + sourceOffset,
        sourceOffset
      );
    }

    var encoded = encodeUtf8(code);

    for (var k = 0; k < encoded.length; k++) {
      bytes.push(encoded[k]);
      offsets.push(sourceOffset);
    }
  }

  return decodeUtf8(bytes, offsets);
}

/**
 * Decode a byte array as strict UTF-8.
 *
 * @param {Number[]} bytes
 * @param {Number[]} offsets raw offset of each byte
 * @return {String}
 * @private
 */

function decodeUtf8(bytes, offsets) {
  var output = '';
  var i = 0;

  while (i < bytes.length) {
    var first = bytes[i];
    var position = offsets[i];

    if (first < 0x80) {
      output += String.fromCharCode(first);
      i++;
      continue;
    }

    var length;
    var min;
    var max;

    if (first >= 0xC2 && first <= 0xDF) {
      length = 2;
      min = 0x80;
      max = 0x7FF;
    } else if (first >= 0xE0 && first <= 0xEF) {
      length = 3;
      min = first === 0xE0 ? 0x800 : 0x80;
      max = first === 0xED ? 0xD7FF : 0xFFFF;
    } else if (first >= 0xF0 && first <= 0xF4) {
      length = 4;
      min = first === 0xF0 ? 0x10000 : 0x1000;
      max = first === 0xF4 ? 0x10FFFF : 0xFFFFF;
    } else {
      // Continuation byte without a lead byte, 0xC0/0xC1 overlong lead
      // byte or 0xF5-0xFF
      throw invalidUtf8(position);
    }

    if (i + length > bytes.length) {
      // Truncated multi-byte sequence: report at the lead byte.
      throw invalidUtf8(position);
    }

    var codepoint = first & ((1 << (7 - length)) - 1);

    for (var j = 1; j < length; j++) {
      var continuation = bytes[i + j];

      if (continuation < 0x80 || continuation > 0xBF) {
        // Report at the offending byte, never at a post-decode offset.
        throw invalidUtf8(offsets[i + j]);
      }

      codepoint = (codepoint << 6) | (continuation & 0x3F);
    }

    if (codepoint < min || codepoint > max) {
      throw invalidUtf8(position);
    }

    if (codepoint > 0xFFFF) {
      codepoint -= 0x10000;
      output += String.fromCharCode(
        0xD800 + (codepoint >> 10),
        0xDC00 + (codepoint & 0x3FF)
      );
    } else {
      output += String.fromCharCode(codepoint);
    }

    i += length;
  }

  return output;
}

/**
 * Encode a Unicode code point as UTF-8 bytes.
 *
 * @param {Number} code
 * @return {Number[]}
 * @private
 */

function encodeUtf8(code) {
  if (code < 0x80) {
    return [code];
  }

  if (code < 0x800) {
    return [
      0xC0 | (code >> 6),
      0x80 | (code & 0x3F)
    ];
  }

  if (code < 0x10000) {
    return [
      0xE0 | (code >> 12),
      0x80 | ((code >> 6) & 0x3F),
      0x80 | (code & 0x3F)
    ];
  }

  return [
    0xF0 | (code >> 18),
    0x80 | ((code >> 12) & 0x3F),
    0x80 | ((code >> 6) & 0x3F),
    0x80 | (code & 0x3F)
  ];
}

/**
 * Return the hex value of a character code, or -1.
 *
 * @param {Number} charCode
 * @return {Number}
 * @private
 */

function hexValue(charCode) {
  if (charCode >= 0x30 && charCode <= 0x39) {
    return charCode - 0x30;
  }

  if (charCode >= 0x41 && charCode <= 0x46) {
    return charCode - 0x41 + 10;
  }

  if (charCode >= 0x61 && charCode <= 0x66) {
    return charCode - 0x61 + 10;
  }

  return -1;
}

/**
 * Build an invalid UTF-8 error at a raw offset.
 *
 * @param {Number} position
 * @return {Error}
 * @private
 */

function invalidUtf8(position) {
  return queryError(
    'INVALID_UTF8',
    'Invalid UTF-8 in query string at position ' + position,
    position
  );
}

/**
 * Build a parser error.
 *
 * @param {String} code
 * @param {String} message
 * @param {Number} position raw offset into the query string
 * @return {Error}
 * @private
 */

function queryError(code, message, position) {
  var err = new Error(message);
  err.code = code;
  err.position = position;
  return err;
}

