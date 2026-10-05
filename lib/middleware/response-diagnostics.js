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

var debug = require('debug')('express:response-diagnostics');

/**
 * Instrumented response methods. Calls to any of these after the
 * response has ended are rejected and reported as diagnostics.
 * @private
 */

var LATE_METHODS = ['write', 'send', 'setHeader', 'writeHead'];

/**
 * Marker to avoid double-instrumenting a single response.
 * @private
 */

var kInstrumented = Symbol('express.responseDiagnostics.instrumented');

/**
 * Response diagnostics middleware.
 *
 * Explicit opt-in middleware that records the moment a response ends
 * (classified as `finish`, `close` or `destroy`, whichever happens
 * first) and reports any later attempt to `send`, `write`, `end`,
 * `setHeader` or `writeHead` on that response.
 *
 * Each diagnostic reports:
 *   - `method`: the late method call (`write`, `send`, `setHeader`, ...)
 *   - `ended`: `{ kind, at, stack }` of the earliest end node
 *   - `callStack`: stack of the late call site
 *   - `error`: an Error describing the late call (its `cause` is the
 *     error passed to `res.destroy(err)`, when any)
 *
 * Late calls are rejected (not forwarded to the underlying response),
 * while genuine errors raised before the first end are left untouched
 * so `next(err)` keeps flowing through the original error chain.
 * The diagnostic reporter itself never writes to the response.
 *
 * Options:
 *   - `reporter(diagnostic)`: called for every late call.
 *     Defaults to logging via `debug`/`console.error`.
 *   - `onEnd(record)`: called once when the earliest end is recorded.
 *
 * @param {object} [options]
 * @return {function}
 * @api public
 */

function responseDiagnostics (options) {
  var opts = options || {}
  var reporter = typeof opts.reporter === 'function'
    ? opts.reporter
    : defaultReporter
  var onEnd = typeof opts.onEnd === 'function'
    ? opts.onEnd
    : null

  return function responseDiagnosticsMiddleware (req, res, next) {
    if (res[kInstrumented]) return next()
    res[kInstrumented] = true

    var endRecord = null

    function recordEnd (kind, cause) {
      if (endRecord) return
      endRecord = {
        kind: kind,
        at: new Date(),
        stack: captureStack('response ended (' + kind + ')')
      }
      if (cause !== undefined) endRecord.cause = cause
      debug('response ended: %s', kind)
      if (onEnd) {
        // the hook must never break the request or write the response
        try { onEnd(endRecord) } catch (err) { debug('onEnd hook threw: %s', err) }
      }
    }

    function isEnded () {
      // NOTE: res.writableEnded is deliberately not consulted here.
      // Node's end() sends implicit headers through the public
      // writeHead() while it runs, so the response must not count as
      // ended until the underlying end() has returned.
      return endRecord !== null || res.destroyed === true
    }

    function reportLate (method) {
      var kind = endRecord ? endRecord.kind : 'unknown'
      var err = new Error('res.' + method + '() called after response ended (' + kind + ')')
      err.method = method
      err.ended = endRecord
        ? { kind: endRecord.kind, at: endRecord.at, stack: endRecord.stack }
        : null
      if (endRecord && endRecord.cause !== undefined) err.cause = endRecord.cause

      var diagnostic = {
        method: method,
        error: err,
        ended: err.ended,
        calledAt: new Date(),
        callStack: captureStack('late res.' + method + '()')
      }

      // the reporter must never write to the response or break the app
      try { reporter(diagnostic) } catch (reportErr) { debug('reporter threw: %s', reportErr) }
      return err
    }

    // record the earliest end node when end()/destroy() run
    var originalEnd = res.end
    res.end = function diagnosticsEnd () {
      if (isEnded()) {
        var err = reportLate('end')
        var cb = lastCallback(arguments)
        if (cb) process.nextTick(cb, err)
        return res
      }
      // record only after the underlying end() ran, so the implicit
      // header write inside it is never mistaken for a late call
      var ret = originalEnd.apply(this, arguments)
      recordEnd('finish')
      return ret
    }

    if (typeof res.destroy === 'function') {
      var originalDestroy = res.destroy
      res.destroy = function diagnosticsDestroy (destroyErr) {
        recordEnd('destroy', destroyErr)
        return originalDestroy.apply(this, arguments)
      }
    }

    // 'finish' confirms a normal end; 'close' alone means the
    // connection went away before the response completed
    res.on('finish', function onFinish () { recordEnd('finish') })
    res.on('close', function onClose () { recordEnd('close') })

    for (var i = 0; i < LATE_METHODS.length; i++) {
      wrapLateMethod(res, LATE_METHODS[i], isEnded, reportLate)
    }

    next()
  }
}

/**
 * Wrap a response method so calls after the first end are rejected
 * and reported. Calls before the first end pass straight through, so
 * genuine errors thrown by the original method are never swallowed.
 * @private
 */

function wrapLateMethod (res, method, isEnded, reportLate) {
  var original = res[method]
  if (typeof original !== 'function') return

  res[method] = function diagnosticsWrapper () {
    if (isEnded()) {
      var err = reportLate(method)
      var cb = lastCallback(arguments)
      if (cb) process.nextTick(cb, err)
      return method === 'write' ? false : res
    }
    return original.apply(this, arguments)
  }
}

/**
 * Return the last argument when it is a callback, else undefined.
 * @private
 */

function lastCallback (args) {
  var last = args[args.length - 1]
  return typeof last === 'function' ? last : undefined
}

/**
 * Capture a stack trace, dropping frames of this module.
 * @private
 */

function captureStack (message) {
  var err = new Error(message)
  return err.stack
}

/**
 * Default reporter: log only, never touch the response.
 * @private
 */

function defaultReporter (diagnostic) {
  debug('late res.%s() after %s\nend site:\n%s\ncall site:\n%s',
    diagnostic.method,
    diagnostic.ended ? diagnostic.ended.kind : 'unknown',
    diagnostic.ended ? diagnostic.ended.stack : '(unknown)',
    diagnostic.callStack)
  console.error('[express:response-diagnostics] res.%s() called after response ended (%s)\nend site:\n%s\ncall site:\n%s',
    diagnostic.method,
    diagnostic.ended ? diagnostic.ended.kind : 'unknown',
    diagnostic.ended ? diagnostic.ended.stack : '(unknown)',
    diagnostic.callStack)
}

/**
 * Module exports.
 */

module.exports = responseDiagnostics;
