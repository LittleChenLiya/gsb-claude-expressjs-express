/*!
 * express
 * Copyright(c) 2009-2013 TJ Holowaychuk
 * Copyright(c) 2024 Express Contributors
 * MIT Licensed
 */

'use strict';

/**
 * Module dependencies.
 * @private
 */

var debug = require('debug')('express:response-diagnostics');

/**
 * Response diagnostics middleware.
 *
 * Instruments the response to detect attempts to call `send`, `write`,
 * `end` or `setHeader` after the response has already ended. Each late
 * call is rejected (the underlying method is not invoked) and a diagnostic
 * is emitted through the configured logger, including the call site of the
 * first end (the "end node") and the call site of the late call.
 *
 * The way the response ended is classified separately:
 *
 *   - `finish`  the response finished normally (the `finish` event fired)
 *   - `close`   the connection was terminated before `finish` fired
 *   - `destroy` `res.destroy()` was called before `finish` or `close`
 *
 * Real errors that occur before the first end are left untouched and
 * continue to bubble through the normal error chain (`next(err)` works as
 * usual). The diagnostics never write to the response themselves.
 *
 * This middleware is opt-in: mount it explicitly to enable it. When it is
 * not mounted, the response behaves exactly as it did before.
 *
 * @param {Object} [options]
 * @param {Function} [options.logger] Function invoked with each diagnostic
 *   object. Defaults to the `debug('express:response-diagnostics')` logger.
 * @return {Function}
 * @public
 */

module.exports = function responseDiagnostics(options) {
  options = options || {};
  var logger = typeof options.logger === 'function' ? options.logger : debug;

  return function responseDiagnostics(req, res, next) {
    // Only instrument each response once.
    if (res.__responseDiagnostics) {
      return next();
    }
    res.__responseDiagnostics = true;

    var state = {
      ended: false,
      endSite: null,
      endClassification: null,
      firstTerminal: null,
      lateCallCount: 0
    };

    // Capture the original methods on the response instance.
    var _end = res.end;
    var _write = res.write;
    var _send = res.send;
    var _setHeader = res.setHeader;
    var _destroy = res.destroy;

    function captureStack(skip) {
      var obj = {};
      Error.captureStackTrace(obj, skip || captureStack);
      return obj.stack;
    }

    function markEnded(site) {
      if (state.ended) return;
      state.ended = true;
      state.endSite = site || captureStack(markEnded);
    }

    function terminal(classification) {
      if (state.firstTerminal) return;
      state.firstTerminal = classification;
      if (!state.ended) {
        state.ended = true;
        state.endSite = captureStack(terminal);
      }
      state.endClassification = classification;
    }

    // Classify the end. `finish` always wins if it fires first; a `close`
    // that follows a normal finish is the regular connection close, not an
    // abort.
    res.once('finish', function onFinish() {
      terminal('finish');
    });
    res.once('close', function onClose() {
      if (!state.firstTerminal) {
        terminal('close');
      }
    });

    res.end = function end(chunk, encoding, callback) {
      if (state.ended) {
        lateCall('end', chunk);
        return this;
      }
      markEnded(captureStack(end));
      return _end.call(this, chunk, encoding, callback);
    };

    res.destroy = function destroy() {
      if (!state.firstTerminal) {
        terminal('destroy');
      }
      return _destroy.apply(this, arguments);
    };

    res.write = function write(chunk, encoding, callback) {
      if (state.ended) {
        lateCall('write', chunk);
        return false;
      }
      return _write.call(this, chunk, encoding, callback);
    };

    if (typeof _send === 'function') {
      res.send = function send(body) {
        if (state.ended) {
          lateCall('send', body);
          return this;
        }
        return _send.call(this, body);
      };
    }

    res.setHeader = function setHeader(field, value) {
      if (state.ended) {
        lateCall('setHeader', field);
        return this;
      }
      return _setHeader.call(this, field, value);
    };

    function lateCall(method, arg) {
      state.lateCallCount++;

      // Build an error for the late call, preserving its cause so callers
      // can inspect what the underlying stream would have done.
      var cause = new Error('response.' + method + '() after end');
      cause.code = method === 'setHeader'
        ? 'ERR_HTTP_HEADERS_SENT'
        : 'ERR_STREAM_WRITE_AFTER_END';

      var err = new Error('Cannot call response.' + method + '() after the response has ended', {
        cause: cause
      });
      err.code = 'ERR_RESPONSE_ALREADY_ENDED';

      var diagnostic = {
        type: 'response:late-' + method,
        method: method,
        classification: state.endClassification || state.firstTerminal || 'unknown',
        endSite: state.endSite,
        callSite: captureStack(lateCall),
        lateCallCount: state.lateCallCount,
        error: err,
        arg: arg
      };

      // Emit the diagnostic through the configured logger. This must never
      // write to the response itself.
      logger(diagnostic);
    }

    next();
  };
};
