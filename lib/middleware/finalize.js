/*!
 * express
 * Copyright(c) 2026 TJ Holowaychuk
 * MIT Licensed
 */

'use strict';

/**
 * Module dependencies.
 */

var once = require('once');

/**
 * Module exports.
 * @public
 */

module.exports = finalize;

/**
 * Finalization stack middleware.
 *
 * Adds a "finalize" stack to the request (`req.finalize`) where route
 * handlers can register cleanup functions that release resources acquired
 * during the request (database connections, file handles, locks, external
 * clients, ...).
 *
 * Resource lifecycle:
 *
 *   1. Register - while handling the request, call `req.finalize.add(fn)`
 *      for every resource that must be released. Functions may be synchronous
 *      or return a Promise; asynchronous cleanup is awaited.
 *   2. Trigger - the stack is finalized exactly once when the response
 *      finishes normally (`finish`), when the underlying connection is
 *      terminated early (`close`, e.g. the client disconnects), or when the
 *      request errors out (the error response finishes). `finish` and
 *      `close` often fire together for the same response, so a `once` guard
 *      guarantees the cleanups run a single time.
 *   3. Freeze - as soon as finalization starts, new registrations are
 *      rejected (an Error is thrown). Registering during finalization would
 *      leak the resource the caller tried to release.
 *   4. Release - cleanups run in reverse registration order (LIFO), so
 *      resources are released in the opposite order they were acquired. A
 *      failing cleanup does not stop the others: every remaining cleanup is
 *      still awaited and all failures are collected.
 *   5. Report - after the stack has run, a single failure is handed to the
 *      explicit `onError` callback as-is; multiple failures are grouped into
 *      an `AggregateError`. If no `onError` is provided, cleanup errors are
 *      silently ignored (the response has already been sent).
 *
 * @param {object} [options]
 * @param {function} [options.onError] Explicit error callback invoked with
 *   one cleanup error, or an `AggregateError` when several cleanups fail.
 * @param {string} [options.field='finalize'] Request property name used to
 *   expose the stack.
 * @return {function} middleware
 * @public
 *
 * @example
 *   app.use(express.finalize({
 *     onError: function (err) { console.error('cleanup failed', err) }
 *   }))
 *
 *   app.get('/', function (req, res) {
 *     var conn = await db.connect()
 *     req.finalize.add(function () { return conn.close() })
 *     res.send('ok')
 *   })
 */

function finalize (options) {
  var opts = options || {};
  var onError = typeof opts.onError === 'function' ? opts.onError : noop;
  var field = typeof opts.field === 'string' ? opts.field : 'finalize';

  return function finalizeMiddleware (req, res, next) {
    var cleanups = [];
    var started = false;

    /**
     * The finalization stack exposed on the request.
     */
    var stack = {
      /**
       * Register a cleanup function. Cleanups run in reverse registration
       * order and may be asynchronous (a returned Promise is awaited).
       *
       * @param {function} fn cleanup, invoked with a context object holding
       *   the `reason` ('finish', 'close' or 'error')
       * @throws {TypeError} if `fn` is not a function
       * @throws {Error} if finalization has already started
       * @public
       */
      add: function add (fn) {
        if (typeof fn !== 'function') {
          throw new TypeError('req.' + field + '.add() expects a function');
        }

        if (started) {
          throw new Error('req.' + field + ': cannot register a cleanup ' +
            'after finalization has started');
        }

        cleanups.push(fn);
      }
    };

    req[field] = stack;

    /**
     * Run the finalization stack. Idempotent: the first call wins and later
     * calls (e.g. `finish` followed by `close`) are ignored.
     */
    var run = once(function runFinalization (reason) {
      started = true;

      // reverse registration order (LIFO)
      var fns = cleanups.slice().reverse();
      var errors = [];

      return fns.reduce(function (chain, fn) {
        return chain.then(function () {
          // wrap in Promise.resolve so sync throws and thenable returns are
          // both handled the same way
          return Promise.resolve(fn({ reason: reason }));
        }).then(undefined, function (err) {
          // keep going: one failure must not prevent the others from running
          errors.push(err);
        });
      }, Promise.resolve()).then(function () {
        if (errors.length === 1) {
          onError(errors[0]);
        } else if (errors.length > 1) {
          onError(createAggregateError(errors));
        }
      });
    });

    // normal completion: res.end() flushed
    res.once('finish', function onFinish () {
      run('finish');
    });

    // connection terminated early (client disconnect / socket close). For a
    // normal response Node emits 'close' right after 'finish', so the once
    // guard keeps this to a single run.
    res.once('close', function onClose () {
      run('close');
    });

    // defensive: middleware attached after the response already finished
    if (res.finished) {
      setImmediate(function () {
        run('finish');
      });
    }

    next();
  };
}

/**
 * Group multiple cleanup errors into a single error.
 *
 * @param {Error[]} errors
 * @return {Error}
 * @private
 */

function createAggregateError (errors) {
  if (typeof AggregateError === 'function') {
    return new AggregateError(errors, 'multiple finalization cleanup errors');
  }

  var err = new Error('multiple finalization cleanup errors');
  err.errors = errors;
  return err;
}

/**
 * No-op.
 * @private
 */

function noop () {}
