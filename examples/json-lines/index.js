'use strict'

var express = require('../../')

var app = module.exports = express()

// Simulated upstream cursor: a row is only produced when the consumer
// asks for one. res.jsonLines() propagates socket backpressure to this
// generator, so rows are never buffered ahead of the client.
async function* queryUsers () {
  for (var id = 1; id <= 1000; id++) {
    // stand-in for an async database fetch
    await new Promise(function (resolve) { setTimeout(resolve, 10) })
    yield { id: id, name: 'user-' + id, bio: 'line one\nline two' }
  }
}

app.get('/users.ndjson', function (req, res) {
  // res.jsonLines() returns a promise for the end of the response.
  // Always attach a rejection handler: when a record fails before the
  // first write, the response is still usable and an error page can be
  // sent; once output has started, the response is destroyed instead.
  res.jsonLines(queryUsers(), { maxBytes: 4096 }).catch(function (err) {
    if (!res.headersSent) {
      res.status(500).type('application/json')
      res.json({ error: err.code || 'INTERNAL', message: err.message })
    } else {
      console.error('stream aborted:', err.message)
    }
  })
})

// HEAD /users.ndjson sends only the response headers
// (Content-Type: application/x-ndjson) and never consumes the iterator.

/* istanbul ignore next */
if (!module.parent) {
  app.listen(3000)
  console.log('Express started on port 3000')
}
