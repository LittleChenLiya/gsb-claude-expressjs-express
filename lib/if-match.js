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
 * @private
 */

var createError = require('http-errors');

/**
 * Module exports.
 * @public
 */

module.exports = ifMatch;

/**
 * Parse an If-Match header value.
 *
 * Per RFC 9110 the header is either the single wildcard * or a
 * comma-separated list of entity tags. An entity tag is an optional
 * case-sensitive W/ weak marker followed by an opaque tag enclosed in
 * double quotes. Commas inside a quoted opaque tag are literal characters
 * and must not be treated as list separators.
 *
 * @param {string} header
 * @return {{wildcard: boolean, tags: Array<{weak: boolean, tag: string}>}}
 * @private
 */

function parseIfMatch(header) {
  var str = header.trim();

  if (str === '') {
    throw createError(400, 'Invalid If-Match header');
  }

  if (str === '*') {
    return { wildcard: true, tags: [] };
  }

  var tags = [];
  var len = str.length;
  var i = 0;

  while (i < len) {
    // skip optional whitespace and empty (comma-only) elements
    while (i < len && (str[i] === ' ' || str[i] === '\t' || str[i] === ',')) {
      i++;
    }
    if (i >= len) {
      break;
    }

    // optional weak marker. RFC 9110 defines the marker as the
    // case-sensitive sequence W/; a lowercase w/ is not a weak marker.
    var weak = false;
    if (str[i] === 'W' && str[i + 1] === '/') {
      weak = true;
      i += 2;
    } else if (str[i] === 'w' && str[i + 1] === '/') {
      throw createError(400, 'Invalid If-Match header: weak marker must be the uppercase W/');
    }

    if (str[i] !== '"') {
      throw createError(400, 'Invalid If-Match header: expected a quoted entity tag');
    }
    i++; // consume opening quote

    var tag = '';
    while (i < len) {
      var ch = str[i];
      if (ch === '"') {
        break;
      }
      var code = ch.charCodeAt(0);
      if (code === 0x7f || (code < 0x20 && ch !== '\t')) {
        throw createError(400, 'Invalid If-Match header: control character in entity tag');
      }
      tag += ch;
      i++;
    }

    if (i >= len) {
      throw createError(400, 'Invalid If-Match header: unclosed entity tag');
    }
    i++; // consume closing quote

    tags.push({ weak: weak, tag: tag });

    // skip optional whitespace before the next element
    while (i < len && (str[i] === ' ' || str[i] === '\t')) {
      i++;
    }

    if (i < len) {
      if (str[i] !== ',') {
        throw createError(400, 'Invalid If-Match header: expected a comma between entity tags');
      }
      i++;
    }
  }

  if (tags.length === 0) {
    throw createError(400, 'Invalid If-Match header: no entity tags');
  }

  return { wildcard: false, tags: tags };
}

/**
 * Extract the opaque tag and strength from a full entity-tag value.
 *
 * Accepts both "tag" and W/"tag" forms (as produced by the etag package)
 * as well as a bare tag for convenience. Returns null for empty or
 * non-string values.
 *
 * @param {string} etag
 * @return {{weak: boolean, tag: string}|null}
 * @private
 */

function opaquePart(etag) {
  if (typeof etag !== 'string' || etag.length === 0) {
    return null;
  }

  var weak = etag.length >= 2 && etag[0] === 'W' && etag[1] === '/';
  var rest = weak ? etag.slice(2) : etag;

  if (rest.length >= 2 && rest[0] === '"' && rest[rest.length - 1] === '"') {
    return { weak: weak, tag: rest.slice(1, -1) };
  }

  return { weak: weak, tag: rest };
}

/**
 * Perform the strong comparison between the current entity tag and the
 * parsed If-Match header.
 *
 * Strong comparison (RFC 9110) requires both entity tags to be strong
 * (not weak) and their opaque tags to match character for character. A
 * weak current tag can never satisfy a strong comparison. Weak tags in
 * the header are ignored for strong comparison. The wildcard * matches
 * when a strong current entity tag exists (i.e. the resource exists).
 *
 * @param {string} currentEtag
 * @param {{wildcard: boolean, tags: Array}} parsed
 * @return {boolean}
 * @private
 */

function strongMatch(currentEtag, parsed) {
  var current = opaquePart(currentEtag);

  // a weak (or missing) current entity tag cannot pass a strong comparison
  if (!current || current.weak) {
    return false;
  }

  if (parsed.wildcard) {
    return true;
  }

  for (var i = 0; i < parsed.tags.length; i++) {
    var t = parsed.tags[i];
    if (t.weak) {
      // weak tags cannot pass a strong comparison
      continue;
    }
    if (t.tag === current.tag) {
      return true;
    }
  }

  return false;
}

/**
 * Query the current strong entity tag for the request.
 *
 * getEtag is called at most once. It may either call the provided
 * callback or return a promise (or both; the first settlement wins). A
 * synchronous throw, a callback error or a rejected promise is surfaced
 * as an error and must be handled by the caller -- it is not treated as
 * a non-match.
 *
 * @param {object} req
 * @param {Function} getEtag
 * @param {Function} cb
 * @private
 */

function queryEtag(req, getEtag, cb) {
  var settled = false;

  function settle(err, etag) {
    if (!settled) {
      settled = true;
      cb(err, etag);
    }
  }

  try {
    var result = getEtag(req, settle);
    if (result && typeof result.then === 'function') {
      result.then(
        function onFulfilled(etag) { settle(null, etag); },
        function onRejected(err) { settle(err); }
      );
    }
  } catch (err) {
    settle(err);
  }
}

/**
 * If-Match precondition middleware.
 *
 * Checks the If-Match request header against the current strong entity
 * tag of the resource before calling next(). This middleware only
 * performs the check: it never updates storage. Downstream handlers are
 * still responsible for performing the actual update atomically (for
 * example with a versioned compare-and-swap). Passing this check does
 * not by itself make concurrent updates safe -- two requests can both
 * pass this check and then race when updating. The middleware does not
 * eliminate the race window; it only rejects requests whose precondition
 * does not match the current version.
 *
 * Options:
 *
 *   - getEtag (required): a function (req, callback) returning the
 *     current strong entity tag for the resource. It may also return a
 *     promise. Called at most once per request. If it errors, the error
 *     is propagated (not turned into a 412).
 *   - requireHeader (default false): when true, a request without an
 *     If-Match header is rejected with 428 Precondition Required. When
 *     false (the RFC default), a missing header means no precondition
 *     and the request proceeds.
 *
 * Status codes:
 *
 *   - 400 malformed If-Match header
 *   - 412 precondition failed (no strong match)
 *   - 428 precondition required (missing header, only when requireHeader)
 *
 * @param {object|Function} options
 * @return {Function}
 * @public
 */

function ifMatch(options) {
  var opts = typeof options === 'function' ? { getEtag: options } : (options || {});
  var getEtag = opts.getEtag;

  if (typeof getEtag !== 'function') {
    throw new TypeError('ifMatch() requires a getEtag function');
  }

  var requireHeader = opts.requireHeader === true;

  return function ifMatchMiddleware(req, res, next) {
    var header = req.get('If-Match');

    // missing header: no precondition (unless explicitly required).
    // an empty header value is present but malformed and falls through
    // to the parser, which reports a 400 syntax error.
    if (header === undefined) {
      if (requireHeader) {
        return next(createError(428, 'If-Match header is required'));
      }
      return next();
    }

    var parsed;
    try {
      parsed = parseIfMatch(header);
    } catch (err) {
      return next(err);
    }

    queryEtag(req, getEtag, function onEtag(err, etag) {
      // a query failure is an error, not a non-match
      if (err) {
        return next(err);
      }

      if (strongMatch(etag, parsed)) {
        return next();
      }

      return next(createError(412, 'If-Match precondition failed'));
    });
  };
}
