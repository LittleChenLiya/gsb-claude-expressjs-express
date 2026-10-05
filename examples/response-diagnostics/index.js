'use strict';

/**
 * Response diagnostics example.
 *
 * `express.responseDiagnostics()` is an explicit opt-in middleware that
 * records when a response ends (classified as `finish`, `close` or
 * `destroy`) and reports any later attempt to `send` / `write` /
 * `setHeader` on it, including the stack of the earliest end node and
 * the stack of the late call site. Late writes are rejected, genuine
 * errors before the first end still flow through `next(err)`, and the
 * reporter itself never writes to the response.
 *
 * Run: node examples/response-diagnostics
 * Then:
 *   curl http://localhost:3000/ok      -> normal route, no diagnostics
 *   curl http://localhost:3000/late    -> "first" only; one late-write
 *                                         diagnostic is logged
 *   curl http://localhost:3000/broken  -> 500 via the error chain
 */

var express = require('../..');

var app = express();

app.use(express.responseDiagnostics({
  reporter: function (diagnostic) {
    // Log only - never write to the response from here.
    console.error('[diagnostic] late res.%s() after response ended (%s)',
      diagnostic.method,
      diagnostic.ended ? diagnostic.ended.kind : 'unknown');
    console.error('[diagnostic] earliest end site:\n%s',
      diagnostic.ended ? diagnostic.ended.stack : '(unknown)');
    console.error('[diagnostic] late call site:\n%s', diagnostic.callStack);
  }
}));

app.get('/ok', function (req, res) {
  res.send('ok\n');
});

app.get('/late', function (req, res) {
  res.send('first\n');
  // Late write: rejected and reported once, the client keeps "first".
  setTimeout(function () {
    res.write('second\n');
  }, 50);
});

app.get('/broken', function (req, res, next) {
  var err = new Error('boom');
  err.cause = new Error('root cause');
  next(err); // still flows through the original error chain
});

app.use(function (err, req, res, next) {
  res.status(500).send('error: ' + err.message +
    (err.cause ? ' (cause: ' + err.cause.message + ')' : '') + '\n');
});

var port = process.env.PORT || 3000;

app.listen(port, function () {
  console.log('listening on http://localhost:' + port);
});
