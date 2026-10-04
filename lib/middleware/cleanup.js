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

var onFinished = require('on-finished');

/**
 * Module exports.
 */

module.exports = cleanup;

/**
 * Create a middleware that attaches a per-request cleanup stack.
 *
 * The returned middleware adds `req.registerCleanup(fn)`, which routes
 * use to register cleanup functions for resources acquired while the
 * request is handled (open handles, temp files, leased connections...).
 *
 * When the response finishes, the connection closes, or an error
 * terminates the request, the registered functions run once, in
 * reverse registration order (LIFO). Cleaners may be async; each one
 * is awaited before the next runs. A failing cleaner does not stop
 * the others: all errors are collected and delivered together to the
 * `onError(errors, req, res)` option callback.
 *
 * Registering after cleanup has started throws, and requests that do
 * not pass through this middleware are untouched.
 *
 * @param {object} [options]
 * @param {function} [options.onError] receives the aggregated errors
 * @return {function} middleware
 * @api public
 */

function cleanup(options) {
  var opts = options || {};
  var onError = opts.onError;

  if (onError !== undefined && typeof onError !== 'function') {
    throw new TypeError('option onError must be a function');
  }

  return function cleanupMiddleware(req, res, next) {
    var stack = [];
    var started = false;

    req.registerCleanup = function registerCleanup(fn) {
      if (typeof fn !== 'function') {
        throw new TypeError('cleanup must be a function');
      }
      if (started) {
        throw new Error('cannot register cleanup: cleanup already started');
      }
      stack.push(fn);
      return fn;
    };

    // on-finished fires exactly once for the first of "finish"/"close";
    // the started flag keeps a late second event from re-running.
    onFinished(res, function () {
      if (started) return;
      started = true;
      drain(stack, req, res, onError);
    });

    next();
  };
}

/**
 * Run the stack in reverse order, awaiting each cleaner and
 * collecting errors without stopping.
 *
 * @param {function[]} stack
 * @param {object} req
 * @param {object} res
 * @param {function} [onError]
 * @api private
 */

async function drain(stack, req, res, onError) {
  var errors = [];

  for (var i = stack.length - 1; i >= 0; i--) {
    try {
      await stack[i](req, res);
    } catch (err) {
      errors.push(err);
    }
  }

  if (errors.length !== 0 && typeof onError === 'function') {
    onError(errors, req, res);
  }
}
