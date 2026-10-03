'use strict'

/**
 * Short local request demo for express.ifMatch().
 *
 * Run with:
 *   node examples/if-match
 *
 * The demo keeps an in-memory resource with a version number. The current
 * strong ETag is derived from that version. PATCH requests go through the
 * ifMatch middleware and then perform an atomic compare-and-swap update.
 *
 * The last part of the demo fires two concurrent requests with the same
 * ETag. Both pass the middleware check, but only one can win the atomic
 * update -- this shows why the middleware alone is not enough and the
 * downstream update must still be version-conditional.
 */

var express = require('../../')
var http = require('http')

// --- in-memory resource ---------------------------------------------------

var resource = { value: 'alpha', version: 1 }

function currentEtag() {
  return '"' + resource.version + '"'
}

// Atomic compare-and-swap: only update when the stored version still
// equals the version the client supplied.
function atomicUpdate(newValue, expectedVersion) {
  if (resource.version !== expectedVersion) {
    return false
  }
  resource.value = newValue
  resource.version++
  return true
}

function parseVersion(etag) {
  return parseInt(etag.replace(/^W\//, '').replace(/"/g, ''), 10)
}

// --- app ------------------------------------------------------------------

var app = express()
app.use(express.json())

app.get('/resource', function (req, res) {
  res.set('ETag', currentEtag())
  res.json({ value: resource.value, version: resource.version })
})

app.patch('/resource',
  express.ifMatch({
    getEtag: function (req, cb) { cb(null, currentEtag()) },
    requireHeader: true
  }),
  function (req, res) {
    // The precondition matched. The update must still be atomic: two
    // requests can both reach this handler with the same ETag.
    var expectedVersion = parseVersion(req.get('If-Match'))
    if (!atomicUpdate(req.body.value, expectedVersion)) {
      return res.status(412).json({ error: 'resource was modified' })
    }
    res.set('ETag', currentEtag())
    res.json({ value: resource.value, version: resource.version })
  }
)

// clean JSON error handler for the demo
app.use(function (err, req, res, next) {
  res.status(err.status || 500).json({ error: err.message })
})

// --- demo helpers ---------------------------------------------------------

function request(method, path, headers, body) {
  return new Promise(function (resolve) {
    var req = http.request({
      port: server.address().port,
      method: method,
      path: path,
      headers: headers
    }, function (res) {
      var data = ''
      res.on('data', function (chunk) { data += chunk })
      res.on('end', function () {
        resolve({ status: res.statusCode, body: data })
      })
    })
    if (body) req.write(body)
    req.end()
  })
}

function log(label, result) {
  console.log(label + ' -> ' + result.status + ' ' + result.body)
}

var server = app.listen(0, async function () {
  // 1. fetch the current ETag
  var get = await request('GET', '/resource')
  log('GET /resource', get)
  var etag = currentEtag()
  console.log('current ETag: ' + etag)

  // 2. PATCH with the correct strong ETag -> 200
  var ok = await request('PATCH', '/resource',
    { 'Content-Type': 'application/json', 'If-Match': etag },
    JSON.stringify({ value: 'bravo' }))
  log('PATCH with correct ETag', ok)

  // 3. PATCH with a weak ETag -> 412 (weak tags never pass strong compare)
  var weak = await request('PATCH', '/resource',
    { 'Content-Type': 'application/json', 'If-Match': 'W/"2"' },
    JSON.stringify({ value: 'charlie' }))
  log('PATCH with weak ETag', weak)

  // 4. PATCH with the now-stale ETag -> 412 (atomic update fails)
  var stale = await request('PATCH', '/resource',
    { 'Content-Type': 'application/json', 'If-Match': etag },
    JSON.stringify({ value: 'delta' }))
  log('PATCH with stale ETag', stale)

  // 5. two concurrent requests with the same ETag: both pass the
  //    middleware check, but only one wins the atomic update.
  var current = currentEtag()
  console.log('current ETag before concurrent race: ' + current)
  var results = await Promise.all([
    request('PATCH', '/resource',
      { 'Content-Type': 'application/json', 'If-Match': current },
      JSON.stringify({ value: 'race-a' })),
    request('PATCH', '/resource',
      { 'Content-Type': 'application/json', 'If-Match': current },
      JSON.stringify({ value: 'race-b' }))
  ])
  results.forEach(function (r, i) {
    log('concurrent PATCH #' + (i + 1), r)
  })
  console.log('final resource: ' + JSON.stringify(resource))
  console.log('note: both requests passed the If-Match check, but the')
  console.log('atomic compare-and-swap let only one update win.')

  server.close()
})
