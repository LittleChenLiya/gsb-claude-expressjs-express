'use strict'

/**
 * This example streams newline-delimited JSON (NDJSON) with res.jsonLines().
 * Records are produced on demand by an async generator, so the response is
 * written line by line while the upstream data is still being generated.
 *
 * Try it:
 *
 *   $ node examples/json-lines/index.js
 *   $ curl -i http://localhost:3000/events
 *   $ curl -I http://localhost:3000/events
 */

var express = require('../../');

var app = module.exports = express()

// Simulates an upstream source (database cursor, message queue, ...) that
// yields records over time instead of materializing them all at once.
async function * generateEvents (count) {
  for (var i = 1; i <= count; i++) {
    await new Promise(function (resolve) { setTimeout(resolve, 100); });
    yield { id: i, message: 'event number ' + i, at: new Date().toISOString() };
  }
}

app.get('/events', function (req, res) {
  // res.jsonLines() returns a Promise for the end of the response. Always
  // handle its rejection: before the first record is written you may still
  // send an error response yourself; once output has started the response
  // is destroyed and no JSON error page is appended.
  res.jsonLines(generateEvents(10), { maxBytes: 4096 }).catch(function (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
      return;
    }

    console.error('export aborted mid-stream:', err.message);
  });
});

// HEAD requests only send the response headers (Content-Type:
// application/x-ndjson); the iterable is never consumed.

/* istanbul ignore next */
if (!module.parent) {
  app.listen(3000);
  console.log('Express started on port 3000');
}
