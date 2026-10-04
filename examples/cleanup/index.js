'use strict'

/**
 * Short HTTP demo of express.cleanup(): a per-request LIFO cleanup
 * stack used to return resources acquired while handling a request.
 *
 * Run:  node examples/cleanup
 * Then: curl http://127.0.0.1:3000/        (normal finish -> cleanup)
 *       curl http://127.0.0.1:3000/fail    (cleaner B throws -> A still runs)
 *       curl -N http://127.0.0.1:3000/slow then Ctrl-C (abort -> cleanup)
 */

var express = require('../../')

var app = module.exports = express()

// fake leased resource: acquire during the request, release in cleanup
function lease (name) {
  console.log('[acquire] ' + name)
  return {
    name: name,
    release: function () {
      return new Promise(function (resolve) {
        setTimeout(function () {
          console.log('[release] ' + name)
          resolve()
        }, 20)
      })
    }
  }
}

app.use(express.cleanup({
  onError: function (errors, req) {
    console.error('[cleanup errors] ' + req.method + ' ' + req.url +
      ': ' + errors.map(function (e) { return e.message }).join(', '))
  }
}))

app.get('/', function (req, res) {
  var a = lease('A')
  var b = lease('B')
  req.registerCleanup(function () { return a.release() }) // runs 2nd (LIFO)
  req.registerCleanup(function () { return b.release() }) // runs 1st
  res.send('registered A and B; watch the console for release order B, A\n')
})

app.get('/fail', function (req, res) {
  var a = lease('A')
  req.registerCleanup(function () { return a.release() }) // still runs
  req.registerCleanup(function () { throw new Error('B failed') })
  res.send('cleaner B will throw; A is still released, error is aggregated\n')
})

app.get('/slow', function (req, res) {
  var a = lease('A')
  req.registerCleanup(function () { return a.release() })
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.write('partial response; abort the request (Ctrl-C) to trigger cleanup\n')
  // response intentionally left open
})

/* istanbul ignore next */
if (!module.parent) {
  app.listen(3000)
  console.log('Express started on port 3000')
}
