'use strict'

/**
 * `If-Match` optimistic concurrency example.
 *
 * Run the short, self-contained local request demo:
 *
 *     node examples/if-match
 *
 * ...or start the server and drive it yourself with curl:
 *
 *     PORT=3000 node examples/if-match server
 *
 *     # show the current state
 *     curl -i http://localhost:3000/items/1
 *     # update using the returned ETag (comma inside the tag is fine)
 *     curl -i -X PUT http://localhost:3000/items/1 \
 *       -H 'If-Match: "1,v1"' -H 'Content-Type: application/json' \
 *       -d '{"title":"new title"}'
 *     # repeat the same update: precondition is now stale
 *     curl -i -X PUT http://localhost:3000/items/1 \
 *       -H 'If-Match: "1,v1"' -H 'Content-Type: application/json' \
 *       -d '{"title":"again"}'
 *
 * Note that express.ifMatch() only performs the HTTP precondition check.
 * The PUT handler below still performs an atomic compare-and-set on the
 * store; see the "Concurrency note" at the bottom of this file.
 */

var express = require('../../')

var app = module.exports = express()
app.use(express.json())
// This example manages ETags itself; do not let res.send() invent weak ones.
app.set('etag', false)

/* tiny in-memory store; the version is part of the ETag */
var store = {
  1: { title: 'first item', version: 1 }
}

function strongEtag(itemId) {
  var item = store[itemId]
  return item ? '"' + itemId + ',v' + item.version + '"' : null
}

/*
 * Read the current representation.
 */
app.get('/items/:id', function (req, res, next) {
  var item = store[req.params.id]
  if (!item) return next()
  res.set('ETag', strongEtag(req.params.id))
  res.send(item)
})

/*
 * Update with an enforced `If-Match` precondition. `requireHeader: true`
 * makes writes without any `If-Match` fail with 428.
 */
app.put('/items/:id',
  express.ifMatch({
    requireHeader: true,
    etag: function (req) {
      // Caller-provided lookup of the current STRONG validator. Returning
      // null means the representation does not exist.
      return Promise.resolve(strongEtag(req.params.id))
    }
  }),
  function (req, res) {
    var expected = req.currentEtag
    var result = compareAndSet(req.params.id, expected, req.body)

    if (!result.changed) {
      // Two requests can pass the middleware check and still collide here.
      // Only the atomic store condition decides who actually updated.
      res.status(412)
      res.set('ETag', strongEtag(req.params.id) || '')
      res.send({ error: 'version conflict', current: result.current })
      return
    }

    res.set('ETag', strongEtag(req.params.id))
    res.send(result.current)
  }
)

/*
 * Atomic check-and-set: the WHERE-style version test happens inside the
 * single store operation, not in JavaScript between read and write.
 */
function compareAndSet(itemId, expectedEtag, patch) {
  var item = store[itemId]
  var currentEtag = item
    ? '"' + itemId + ',v' + item.version + '"'
    : null

  if (currentEtag !== expectedEtag) {
    return { changed: false, current: item }
  }

  var updated = Object.assign({}, item, patch, {
    version: item.version + 1
  })
  store[itemId] = updated
  return { changed: true, current: updated }
}

/* eslint-disable no-unused-vars */
app.use(function (err, req, res, next) {
  res.status(err.status || err.statusCode || 500)
  res.send({ error: err.message })
})
/* eslint-enable no-unused-vars */

/* istanbul ignore next */
if (!module.parent) {
  if (process.argv[2] === 'server') {
    app.listen(process.env.PORT || 3000)
    console.log('If-Match example listening on port ' + (process.env.PORT || 3000))
  } else {
    runDemo()
  }
}

/**
 * Short local-request demo: boots the app on an ephemeral port, issues
 * real HTTP requests with the global fetch(), and prints each result.
 *
 * @private
 */

/* istanbul ignore next */
function runDemo() {
  var server = app.listen(0, '127.0.0.1', function () {
    var port = server.address().port
    var base = 'http://127.0.0.1:' + port

    Promise.resolve()
      .then(function () {
        return request('GET', base + '/items/1').then(function (res) {
          log(1, 'GET current state (note ETag contains a comma)', res)
          return res.etag
        })
      })
      .then(function (etag) {
        return request('PUT', base + '/items/1', {
          headers: { 'If-Match': etag, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'updated once' })
        }).then(function (res) {
          log(2, 'PUT with matching strong If-Match', res)
        })
      })
      .then(function () {
        return request('PUT', base + '/items/1', {
          headers: {
            'If-Match': 'W/"1,v2"',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ title: 'weak tag' })
        }).then(function (res) {
          log(3, 'PUT with weak W/ tag never matches strongly', res)
        })
      })
      .then(function () {
        return request('PUT', base + '/items/1', {
          headers: {
            'If-Match': '"1,v1"',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ title: 'stale' })
        }).then(function (res) {
          log(4, 'PUT reusing the stale first ETag', res)
        })
      })
      .then(function () {
        return request('PUT', base + '/items/1', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'no precondition' })
        }).then(function (res) {
          log(5, 'PUT without If-Match (requireHeader)', res)
        })
      })
      .then(function () {
        return request('PUT', base + '/items/1', {
          headers: {
            'If-Match': '"unterminated',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ title: 'bad syntax' })
        }).then(function (res) {
          log(6, 'PUT with malformed If-Match', res)
        })
      })
      .then(function () {
        // Concurrency demonstration: two requests carrying the same,
        // currently-valid tag. Both pass the middleware; the atomic
        // compare-and-set still serializes them and rejects the loser.
        return request('GET', base + '/items/1').then(function (res) {
          return res.etag
        })
      })
      .then(function (etag) {
        var opts = function (title) {
          return {
            headers: {
              'If-Match': etag,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ title: title })
          }
        }

        return Promise.all([
          request('PUT', base + '/items/1', opts('concurrent A')),
          request('PUT', base + '/items/1', opts('concurrent B'))
        ]).then(function (results) {
          var statuses = results.map(function (r) { return r.status })
          console.log('7. two concurrent PUTs with the same valid tag -> ' +
            statuses.join(' and ') +
            ' (both passed ifMatch; the atomic CAS still rejects the loser)')
        })
      })
      .then(function () {
        server.close()
      })
      .catch(function (err) {
        console.error(err)
        server.close(function () { process.exitCode = 1 })
      })
  })
}

/* istanbul ignore next */
function request(method, url, options) {
  return fetch(url, Object.assign({ method: method }, options || {}))
    .then(function (res) {
      return res.text().then(function (text) {
        var parsed
        try { parsed = text ? JSON.parse(text) : '' } catch (e) { parsed = text }
        return {
          status: res.status,
          etag: res.headers.get('etag'),
          body: parsed
        }
      })
    })
}

/* istanbul ignore next */
function log(n, label, res) {
  console.log(n + '. ' + label + ' -> ' + res.status +
    (res.etag ? ' (ETag ' + res.etag + ')' : '') + '\n   ' +
    JSON.stringify(res.body))
}
