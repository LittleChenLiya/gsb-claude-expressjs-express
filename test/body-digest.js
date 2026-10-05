'use strict'

var assert = require('node:assert')
var Buffer = require('node:buffer').Buffer
var crypto = require('node:crypto')
var http = require('node:http')

var express = require('..')

function sha256 (buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// Send chunks as separate writes, then optionally destroy instead of end.
function sendChunks (server, chunks, headers, onresponse, shouldDestroy) {
  var req = http.request({
    port: server.address().port,
    method: 'POST',
    path: '/',
    headers: headers
  }, onresponse)

  req.on('error', function () { /* expected when we destroy mid-body */ })

  ;(function send (i) {
    if (i === chunks.length) {
      if (shouldDestroy) return req.destroy()
      return req.end()
    }
    req.write(chunks[i], function () {
      setTimeout(function () { send(i + 1) }, 15)
    })
  })(0)

  return req
}

function readJson (res, cb) {
  var data = ''
  res.on('data', function (c) { data += c })
  res.on('end', function () { cb(JSON.parse(data)) })
}

describe('express.bodyDigest()', function () {
  it('should digest the exact parser bytes across three chunks and keep parsing intact', function (done) {
    var chunks = ['{"user":"t', 'obi","tags":["a', '","b"],"n":42}']
    var body = chunks.join('')

    var app = express()
    app.use(express.bodyDigest())
    app.use(express.json())
    app.use(function (req, res) {
      // the tap must not rewrite headers / Content-Encoding
      assert.strictEqual(req.headers['content-encoding'], 'identity')
      assert.strictEqual(req.headers['content-type'], 'application/json')
      res.json({
        parsed: req.body,
        status: req.bodyDigest.status,
        digest: req.bodyDigest.digest,
        bytes: req.bodyDigest.bytes
      })
    })

    var server = app.listen(0, function () {
      sendChunks(server, chunks, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'identity',
        'Transfer-Encoding': 'chunked'
      }, function (res) {
        readJson(res, function (json) {
          assert.strictEqual(res.statusCode, 200)
          assert.strictEqual(json.status, 'complete')
          // digest of the raw bytes, equal to hashing the whole body at once
          assert.strictEqual(json.digest, sha256(Buffer.from(body)))
          assert.strictEqual(json.bytes, Buffer.byteLength(body))
          // downstream parser still got the untouched bytes
          assert.deepStrictEqual(json.parsed, JSON.parse(body))
          server.close(done)
        })
      })
    })
  })

  it('should report "aborted" (never a partial digest) when the connection drops at the second chunk', function (done) {
    var chunks = ['{"user":"t', 'obi","tags":["a', '","b"],"n":42}']
    var body = chunks.join('')
    var state

    var app = express()
    app.use(express.bodyDigest())
    app.use(function (req, res, next) {
      state = req.bodyDigest
      req.on('close', function () {
        assert.strictEqual(state.status, 'aborted')
        assert.strictEqual(state.digest, null)
        assert.ok(state.bytes < Buffer.byteLength(body))
        server.close(done)
      })
      next()
    })
    app.use(express.json())
    app.use(function (req, res) { res.end('unreachable') })

    var server = app.listen(0, function () {
      sendChunks(server, chunks.slice(0, 2), {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body))
      }, function () { /* no response expected */ }, true)
    })
  })

  it('should report "overflow" past the byte limit while the parser still gets every byte', function (done) {
    var body = '{"user":"tobi","n":42}'

    var app = express()
    app.use(express.bodyDigest({ limit: 10 }))
    app.use(express.json())
    app.use(function (req, res) {
      res.json({
        parsed: req.body,
        status: req.bodyDigest.status,
        digest: req.bodyDigest.digest,
        bytes: req.bodyDigest.bytes
      })
    })

    var server = app.listen(0, function () {
      sendChunks(server, [body], {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body))
      }, function (res) {
        readJson(res, function (json) {
          assert.strictEqual(json.status, 'overflow')
          assert.strictEqual(json.digest, null)
          assert.strictEqual(json.bytes, Buffer.byteLength(body))
          // overflow must not truncate or alter the downstream stream
          assert.deepStrictEqual(json.parsed, JSON.parse(body))
          server.close(done)
        })
      })
    })
  })

  it('should report "failed" when the downstream parser rejects the body (wrap)', function (done) {
    var body = '{"broken":'

    var app = express()
    app.use(express.bodyDigest.wrap(express.json()))
    app.use(function (req, res) { res.end('unreachable') })
    app.use(function (err, req, res, next) {
      res.status(400).json({
        status: req.bodyDigest.status,
        digest: req.bodyDigest.digest,
        hasError: req.bodyDigest.error !== null
      })
    })

    var server = app.listen(0, function () {
      sendChunks(server, [body], {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body))
      }, function (res) {
        readJson(res, function (json) {
          assert.strictEqual(res.statusCode, 400)
          // the bytes streamed fully, but parse failure must not look like success
          assert.strictEqual(json.status, 'failed')
          assert.strictEqual(json.digest, null)
          assert.strictEqual(json.hasError, true)
          server.close(done)
        })
      })
    })
  })

  it('should follow downstream backpressure with a slow consumer (never hash ahead)', function (done) {
    var PassThrough = require('node:stream').PassThrough
    var chunkCount = 8
    var delay = 20
    var tolerance = 5
    var chunk = Buffer.alloc(1024, 0x61)
    var parts = []
    for (var i = 0; i < chunkCount; i++) parts.push(chunk)
    var body = Buffer.concat(parts)

    // stream-level slow-consumer fixture: the producer dumps every chunk
    // into the stream buffer at once; only downstream resume() paces delivery
    var req = new PassThrough()
    express.bodyDigest()(req, {}, function () {})
    var state = req.bodyDigest

    var consumed = 0
    var lockstep = true
    var gapsOk = true
    var deliveries = 0
    var last = 0

    req.pause()
    req.on('data', function (data) {
      var now = Date.now()
      if (last && now - last < delay - tolerance) gapsOk = false
      last = now
      deliveries++
      consumed += data.length
      // the tap observes the same delivery but must never run ahead of it
      if (state.bytes !== consumed) lockstep = false
      req.pause()
      setTimeout(function () { req.resume() }, delay)
    })
    req.on('end', function () {
      assert.strictEqual(state.status, 'complete')
      assert.strictEqual(state.digest, sha256(body))
      assert.strictEqual(consumed, body.length)
      assert.strictEqual(deliveries, chunkCount)
      // hashing stayed in lockstep with the throttled consumer
      assert.strictEqual(lockstep, true)
      // every delivery waited for the consumer's resume: backpressure followed
      assert.strictEqual(gapsOk, true)
      done()
    })

    for (var j = 0; j < chunkCount; j++) req.write(parts[j])
    req.end()
    setTimeout(function () { req.resume() }, delay)
  })
})
