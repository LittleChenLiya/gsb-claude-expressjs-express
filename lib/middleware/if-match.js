/*!
 * express
 * Copyright(c) 2026 Contributors
 * MIT Licensed
 */

'use strict';

/**
 * Module dependencies.
 * @private
 */

var createError = require('http-errors');

/**
 * Optional middleware that enforces the HTTP `If-Match` precondition
 * (RFC 9110, section 13.1.1) using the strong comparison function
 * (RFC 9110, section 8.8.1.1) on write requests.
 *
 * The caller supplies the current strong validator for the target resource
 * via `options.etag`. This middleware never reads from or writes to a store
 * itself; it only compares the client-supplied precondition with the current
 * validator the caller provides.
 *
 * Options:
 *
 *   - `etag`      (required) Function `(req, cb)`, `(req)` returning a
 *                 Promise, or `(req)` returning the tag synchronously. It
 *                 MUST resolve/respond with the current strong
 *                 entity-tag of the target resource as a quoted string
 *                 (for example `'"v1"'`), or with `null`/`undefined` when the
 *                 selected representation does not exist. It is invoked at
 *                 most once per request, and only when the parsed
 *                 precondition must be compared with a current tag.
 *   - `requireHeader` (optional, default `false`). When `true`, a request
 *                 without an `If-Match` header is rejected with
 *                 428 Precondition Required. When `false` (the RFC 9110
 *                 default behavior for `If-Match`), a missing header causes
 *                 `next()` to be called without any precondition check.
 *
 * Responses on the failure paths:
 *
 *   - 400 Bad Request           malformed `If-Match` header syntax
 *   - 412 Precondition Failed   the precondition evaluates to false
 *                               (including `*` when the resource does not
 *                               exist, and weak validators under the strong
 *                               comparison)
 *   - 428 Precondition Required missing header with `requireHeader: true`
 *
 * On success `next()` is called and, when the current tag was queried, it is
 * exposed as `req.currentEtag` so the downstream handler can reuse it.
 *
 * IMPORTANT: passing this check does NOT serialize an update. Two concurrent
 * requests can both pass and still race. The downstream write MUST still use
 * an atomic version/ETag condition in the storage layer (for example a
 * conditional `UPDATE ... WHERE version = ?` check-and-set,
 * compare-and-swap, or an optimistic-locking transaction). This middleware
 * only rejects requests whose precondition is already known to be stale; it
 * does not eliminate the check-then-act race window.
 *
 * @param {Object} [options]
 * @return {Function} middleware
 * @public
 */

module.exports = function ifMatch(options) {
  var opts = options || {};
  var getCurrentEtag = opts.etag;

  if (typeof getCurrentEtag !== 'function') {
    throw new TypeError('express.ifMatch: options.etag must be a function');
  }

  var requireHeader = opts.requireHeader === true;

  return function ifMatchMiddleware(req, res, next) {
    var raw = req.headers['if-match'];

    if (raw === undefined) {
      if (requireHeader) {
        next(createError(428, 'Precondition Required', {
          code: 'PRECONDITION_REQUIRED'
        }));
        return;
      }

      // No precondition was supplied; per RFC 9110 If-Match is then ignored.
      next();
      return;
    }

    var parsed;
    try {
      parsed = parseIfMatch(raw);
    } catch (err) {
      next(createError(400, 'Invalid If-Match header', {
        code: 'INVALID_IF_MATCH'
      }));
      return;
    }

    // The parser returns either `{ wildcard: true }` or
    // `{ wildcard: false, tags: [...] }`; the two forms are mutually
    // exclusive in a single header field value.
    if (parsed.wildcard) {
      queryCurrentEtag(req, function (err, currentEtag) {
        if (err) {
          // A lookup failure is not a failed precondition; do not turn it
          // into 412. Propagate so the application error handler decides.
          next(err);
          return;
        }

        if (currentEtag != null) {
          req.currentEtag = currentEtag;
          next();
          return;
        }

        next(createError(412, 'Precondition Failed', {
          code: 'PRECONDITION_FAILED'
        }));
      });
      return;
    }

    var tags = parsed.tags;

    queryCurrentEtag(req, function (err, currentEtag) {
      if (err) {
        next(err);
        return;
      }

      if (currentEtag != null && strongMatch(tags, currentEtag)) {
        req.currentEtag = currentEtag;
        next();
        return;
      }

      next(createError(412, 'Precondition Failed', {
        code: 'PRECONDITION_FAILED'
      }));
    });
  };

  /**
   * Invoke the caller-supplied current-tag provider at most once.
   * Supported provider shapes are a `(req, callback)` Node-style
   * function, a function returning a Promise/thenable, or a function
   * returning the tag synchronously.
   *
   * @param {Object} req
   * @param {Function} cb
   * @private
   */

  function queryCurrentEtag(req, cb) {
    var settled = false;

    function settle(err, value) {
      if (settled) {
        return;
      }
      settled = true;
      cb(err, value);
    }

    var result;
    try {
      if (getCurrentEtag.length >= 2) {
        getCurrentEtag(req, function (err, value) {
          settle(err, value);
        });
        return;
      }

      result = getCurrentEtag(req);
    } catch (err) {
      settle(err);
      return;
    }

    if (result && typeof result.then === 'function') {
      result.then(
        function (value) { settle(null, value); },
        function (err) { settle(err || new Error('etag provider rejected')); }
      );
      return;
    }

    // Synchronous return value (including null/undefined for "absent").
    settle(null, result);
  }
};

/**
 * Apply the RFC 9110 strong comparison function between the current
 * validator and the parsed list from the header.
 *
 * Weak validators from the header never match, even when their opaque tags
 * are byte-identical to the current strong validator. A weak validator
 * returned by the current-tag provider does not match either. Comparison is
 * on the complete quoted entity-tag (`"..."`) so callers pass tags exactly
 * as they appear on responses and in the header.
 *
 * @param {Array.<{weak: boolean, tag: string}>} tags
 * @param {string} currentEtag
 * @return {boolean}
 * @private
 */

function strongMatch(tags, currentEtag) {
  if (typeof currentEtag !== 'string' || currentEtag.charAt(0) !== '"') {
    // Only strong, quoted current validators can participate.
    return false;
  }

  for (var i = 0; i < tags.length; i++) {
    if (!tags[i].weak && tags[i].tag === currentEtag) {
      return true;
    }
  }

  return false;
}

/**
 * Parse an `If-Match` header field value per RFC 9110.
 *
 * Grammar implemented:
 *
 *   If-Match   = "*" / 1#entity-tag
 *   entity-tag = [ weak ] opaque-tag
 *   weak       = %x57.2F   ; "W/", case-sensitive
 *   opaque-tag = DQUOTE *etagc DQUOTE
 *
 * Commas inside a quoted tag are content, not list separators. Surrounding
 * OWS is tolerated. Anything not matching the grammar throws.
 *
 * @param {string} value
 * @return {{wildcard: boolean, tags?: Array}}
 * @throws {Error} on any syntax violation
 * @private
 */

function parseIfMatch(value) {
  var input = String(value);
  var length = input.length;
  var index = 0;

  index = skipOws(input, index);

  if (index === length) {
    throw new Error('empty If-Match header');
  }

  if (input.charAt(index) === '*') {
    var afterStar = skipOws(input, index + 1);
    if (afterStar !== length) {
      throw new Error('wildcard must not be combined with entity-tags');
    }

    return { wildcard: true };
  }

  var tags = [];

  while (true) {
    // Parse one entity-tag.
    var weak = false;

    if (input.charAt(index) === 'W' && input.charAt(index + 1) === '/') {
      weak = true;
      index += 2;
    }

    if (input.charAt(index) !== '"') {
      throw new Error('expected quoted entity-tag');
    }

    var tagStart = index;
    index += 1;

    // Scan the opaque quoted tag (etagc is everything except DQUOTE).
    while (index < length && input.charAt(index) !== '"') {
      index += 1;
    }

    if (index >= length) {
      throw new Error('unterminated quoted entity-tag');
    }

    // Include the closing quote in the stored tag for byte comparison.
    index += 1;
    var tag = input.slice(tagStart, index);
    tags.push({ weak: weak, tag: tag });

    index = skipOws(input, index);

    if (index === length) {
      break;
    }

    if (input.charAt(index) !== ',') {
      throw new Error('expected comma between entity-tags');
    }

    index += 1;
    index = skipOws(input, index);

    // The "#rule" production requires another element after the comma.
    if (index === length) {
      throw new Error('trailing comma in If-Match header');
    }
  }

  if (tags.length === 0) {
    throw new Error('If-Match requires at least one entity-tag');
  }

  return { wildcard: false, tags: tags };
}

/**
 * Skip RFC 9110 optional whitespace (SP / HTAB).
 *
 * @param {string} input
 * @param {number} index
 * @return {number}
 * @private
 */

function skipOws(input, index) {
  while (index < input.length) {
    var charCode = input.charCodeAt(index);
    if (charCode === 0x20 || charCode === 0x09) {
      index += 1;
    } else {
      break;
    }
  }

  return index;
}
