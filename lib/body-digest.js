/*!
 * express
 * Copyright(c) 2009-2013 TJ Holowaychuk
 * Copyright(c) 2013 Roman Shtylman
 * Copyright(c) 2014-2015 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict'

/**
 * Module dependencies.
 */

var crypto = require('node:crypto')

/**
 * Body digest bypass middleware.
 *
 * Taps the raw request stream and incrementally digests the exact bytes
 * that are delivered to the downstream body parser (e.g. express.json()),
 * without buffering the body, without re-creating the request, and without
 * touching Content-Encoding or any header. The parser receives its bytes
 * unchanged; this middleware only observes the same 'data' events.
 *
 * Backpressure: the tap never calls read()/resume()/pause() and never
 * buffers. Hashing happens synchronously inside the 'data' dispatch that
 * the downstream consumer's own reading causes, so digest progress is
 * always in lockstep with downstream consumption; when the downstream
 * pauses the stream, delivery (and therefore hashing) pauses too.
 *
 * Digest state machine (exposed as `req.bodyDigest` by default):
 *
 *   status      meaning                                              digest
 *   ----------  ---------------------------------------------------  ------
 *   'pending'   body still streaming, no terminal state reached yet  null
 *   'complete'  clean EOF at or under the byte limit                 hex string
 *   'overflow'  more than `limit` bytes arrived, hashing stopped     null
 *   'aborted'   connection closed before EOF (client disconnect)     null
 *   'failed'    request stream errored, or a downstream parser
 *               reported failure via state.fail(err) / .wrap()       null
 *
 * Invariant: `state.digest` is non-null ONLY when `status === 'complete'`.
 * A partial digest is never exposed as a successful result. The first
 * terminal state wins, except that fail() may still override 'pending'
 * and 'complete' (a body that streamed fully but failed to parse is a
 * failure, not a success).
 *
 * @param {object} [options]
 * @param {string} [options.algorithm='sha256']  crypto hash algorithm
 * @param {number} [options.limit=1048576]       max bytes to digest before 'overflow'
 * @param {string} [options.property='bodyDigest']  req property holding the state
 * @return {function} middleware
 * @api public
 */

function bodyDigest (options) {
  var opts = options || {}
  var algorithm = opts.algorithm || 'sha256'
  var limit = opts.limit == null ? 1024 * 1024 : opts.limit
  var property = opts.property || 'bodyDigest'

  if (typeof limit !== 'number' || limit < 0) {
    throw new TypeError('option limit must be a non-negative number')
  }

  return function bodyDigestMiddleware (req, res, next) {
    var hash = crypto.createHash(algorithm)

    var state = req[property] = {
      status: 'pending',
      algorithm: algorithm,
      bytes: 0,
      digest: null,
      error: null,
      fail: fail
    }

    // Mark the digest as failed from a downstream parser / error handler.
    function fail (err) {
      if (state.status === 'pending' || state.status === 'complete') {
        state.status = 'failed'
        state.error = err || null
        state.digest = null
        hash = null
      }
      return state
    }

    // Observe only; never pull, never buffer, never re-emit.
    function ondata (chunk) {
      if (state.status !== 'pending') return
      state.bytes += chunk.length
      if (state.bytes > limit) {
        state.status = 'overflow'
        state.digest = null
        hash = null
        return
      }
      hash.update(chunk)
    }

    function onend () {
      if (state.status !== 'pending') return
      state.status = 'complete'
      state.digest = hash.digest('hex')
      hash = null
    }

    function onerror (err) {
      if (state.status !== 'pending' && state.status !== 'complete') return
      // A dropped connection surfaces as ECONNRESET with req.aborted set;
      // that is an abort, not a processing failure.
      if (req.aborted || (err && (err.code === 'ECONNRESET' || err.code === 'EPIPE'))) {
        state.status = 'aborted'
      } else {
        state.status = 'failed'
      }
      state.error = err || null
      state.digest = null
      hash = null
    }

    function onclose () {
      // 'close' also fires after a clean 'end'; only a still-pending
      // state means the connection dropped before EOF.
      if (state.status === 'pending') {
        state.status = 'aborted'
        state.digest = null
        hash = null
      }
    }

    req.on('data', ondata)
    req.on('end', onend)
    req.on('error', onerror)
    req.on('close', onclose)

    next()
  }
}

/**
 * Combine the digest tap with a downstream body parser into one
 * middleware. Bytes flow to the parser exactly as before; if the parser
 * reports an error (e.g. malformed JSON), the digest state is marked
 * 'failed' automatically so a parsed-then-failed body is never reported
 * as a successful digest.
 *
 * @param {function} parser  downstream parser middleware, e.g. express.json()
 * @param {object} [options] same options as bodyDigest()
 * @return {function} middleware
 * @api public
 */

bodyDigest.wrap = function wrap (parser, options) {
  if (typeof parser !== 'function') {
    throw new TypeError('argument parser must be a function')
  }

  var tap = bodyDigest(options)
  var property = (options && options.property) || 'bodyDigest'

  return function bodyDigestWrappedParser (req, res, next) {
    tap(req, res, function (err) {
      if (err) return next(err)
      parser(req, res, function (parseErr) {
        if (parseErr) {
          var state = req[property]
          if (state) state.fail(parseErr)
        }
        next(parseErr)
      })
    })
  }
}

/**
 * Expose the middleware.
 */

module.exports = bodyDigest
