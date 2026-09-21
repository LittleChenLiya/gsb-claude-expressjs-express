'use strict'

var express = require('../')
var http = require('node:http')
var request = require('supertest')
var assert = require('node:assert')
var Writable = require('node:stream').Writable
var res = require('../lib/response')

function tick () {
  return new Promise(function (resolve) { setImmediate(resolve) })
}

// a response-like Writable with manually releasable backpressure:
// every _write callback is held until release() is called, and the
// highWaterMark of 1 makes write() return false while anything is held
function fakeResponse (settings, method) {
  var headers = {}
  var held = []
  var stream = new Writable({
    highWaterMark: 1,
    write: function (chunk, encoding, callback) {
      stream.chunks.push(chunk.toString())
      held.push(callback)
    }
  })
  stream.chunks = []
  stream.app = { get: function (name) { return settings[name] } }
  stream.req = { method: method || 'GET' }
  stream.headersSent = false
  stream.get = function (key) { return headers[key.toLowerCase()] }
  stream.set = function (key, value) {
    headers[key.toLowerCase()] = value
    return stream
  }
  stream.release = function () {
    held.splice(0).forEach(function (callback) { callback() })
  }
  return stream
}

function defaultSettings () {
  return {
    'json escape': false,
    'json replacer': undefined,
    'json spaces': undefined
  }
}

// an async iterator that counts next()/return() calls
function countingIterator (values, options) {
  options = options || {}
  var index = 0
  var calls = { next: 0, return: 0 }
  var iterator = {
    next: function () {
      calls.next++
      if (options.holdNextAt === calls.next) {
        return options.holdNextPromise // only settles when the test says so
      }
      if (index >= values.length) {
        return Promise.resolve({ done: true, value: undefined })
      }
      var value = values[index++]
      if (value instanceof Error) return Promise.reject(value)
      if (options.throwOn === value) throw value
      return Promise.resolve({ done: false, value: value })
    },
    return: function () {
      calls.return++
      return options.returnRejects
        ? Promise.reject(new Error('iterator return failed'))
        : Promise.resolve({ done: true, value: undefined })
    }
  }
  iterator[Symbol.asyncIterator] = function () { return iterator }
  return { iterator: iterator, calls: calls }
}

describe('res', function () {
  describe('.jsonLines(iterable)', function () {
    it('should stream records as NDJSON, one physical line each', function (done) {
      var app = express()
      app.set('json spaces', 2)

      app.use(function (req, res) {
        res.jsonLines([
          { text: 'line one\nline two' },
          { text: 'another\nrecord' }
        ]).catch(done)
      })

      request(app)
        .get('/')
        .expect('Content-Type', 'application/x-ndjson; charset=utf-8')
        .expect(200)
        .expect(function (res) {
          var lines = res.text.split('\n')
          assert.strictEqual(lines.length, 3)
          assert.strictEqual(lines[2], '')
          assert.deepStrictEqual(JSON.parse(lines[0]), { text: 'line one\nline two' })
          assert.deepStrictEqual(JSON.parse(lines[1]), { text: 'another\nrecord' })
        })
        .end(done)
    })

    it('should support async iterables and resolve when finished', function (done) {
      var app = express()

      async function* rows () {
        yield { id: 1 }
        yield { id: 2 }
      }

      app.use(function (req, res) {
        res.jsonLines(rows()).catch(done)
      })

      request(app)
        .get('/')
        .expect(200, '{"id":1}\n{"id":2}\n', done)
    })

    it('should honor the json replacer and json escape settings', function (done) {
      var app = express()
      app.set('json replacer', function (key, value) {
        return key === 'secret' ? undefined : value
      })
      app.set('json escape', true)

      app.use(function (req, res) {
        res.jsonLines([{ secret: 1, html: '<b>&</b>' }]).catch(done)
      })

      request(app)
        .get('/')
        .expect(200, '{"html":"\\u003cb\\u003e\\u0026\\u003c/b\\u003e"}\n', done)
    })

    it('should reject non-iterables before touching the response', async function () {
      var stream = fakeResponse(defaultSettings())
      await assert.rejects(
        res.jsonLines.call(stream, 42),
        /iterable/
      )
      assert.strictEqual(stream.destroyed, false)
    })

    describe('backpressure', function () {
      it('should not call next() after write() returns false until drain', async function () {
        var stream = fakeResponse(defaultSettings())
        var source = countingIterator([{ n: 1 }, { n: 2 }, { n: 3 }])

        var promise = res.jsonLines.call(stream, source.iterator)

        await tick()
        await tick()
        // first record written, write() returned false, pump stalled
        assert.strictEqual(source.calls.next, 1)
        assert.deepStrictEqual(stream.chunks, ['{"n":1}\n'])

        await tick()
        assert.strictEqual(source.calls.next, 1)

        stream.release()
        await tick()
        await tick()
        assert.strictEqual(source.calls.next, 2)
        assert.deepStrictEqual(stream.chunks, ['{"n":1}\n', '{"n":2}\n'])

        stream.release()
        await tick()
        await tick()
        assert.strictEqual(source.calls.next, 3)

        stream.release()
        await tick()
        await tick()
        // final next() observes done: true and ends the response
        assert.strictEqual(source.calls.next, 4)
        await promise
        assert.strictEqual(stream.writableEnded, true)
      })
    })

    describe('record size limit', function () {
      it('should accept a record of exactly maxBytes UTF-8 bytes', async function () {
        var stream = fakeResponse(defaultSettings())
        // JSON.stringify of two e-acutes is 4 chars but 6 UTF-8 bytes
        var promise = res.jsonLines.call(stream, ['\u00e9\u00e9'], { maxBytes: 6 })
        await tick()
        await tick()
        stream.release()
        await promise
        assert.deepStrictEqual(stream.chunks, ['"\u00e9\u00e9"\n'])
      })

      it('should reject a record exceeding maxBytes', async function () {
        var stream = fakeResponse(defaultSettings())
        await assert.rejects(
          res.jsonLines.call(stream, ['\u00e9\u00e9'], { maxBytes: 5 }),
          function (err) {
            assert.strictEqual(err.code, 'EXPRESS_JSON_LINES_RECORD_TOO_LARGE')
            assert.strictEqual(err.recordBytes, 6)
            assert.strictEqual(err.maxBytes, 5)
            return true
          }
        )
        // nothing written, response still usable by the caller
        assert.deepStrictEqual(stream.chunks, [])
        assert.strictEqual(stream.destroyed, false)
      })
    })

    describe('serialization errors', function () {
      it('should reject undefined records with a distinct error', async function () {
        var stream = fakeResponse(defaultSettings())
        await assert.rejects(
          res.jsonLines.call(stream, [undefined]),
          function (err) {
            assert.strictEqual(err.code, 'EXPRESS_JSON_LINES_UNDEFINED')
            return true
          }
        )
        assert.deepStrictEqual(stream.chunks, [])
        assert.strictEqual(stream.destroyed, false)
      })

      it('should reject BigInt records with a distinct error', async function () {
        var stream = fakeResponse(defaultSettings())
        await assert.rejects(
          res.jsonLines.call(stream, [10n]),
          function (err) {
            assert.strictEqual(err.code, 'EXPRESS_JSON_LINES_BIGINT')
            return true
          }
        )
      })

      it('should reject circular records with a distinct error', async function () {
        var stream = fakeResponse(defaultSettings())
        var value = {}
        value.self = value
        await assert.rejects(
          res.jsonLines.call(stream, [value]),
          function (err) {
            assert.strictEqual(err.code, 'EXPRESS_JSON_LINES_CIRCULAR')
            return true
          }
        )
      })

      it('should let the caller respond when the first record fails', function (done) {
        var app = express()

        app.use(function (req, res) {
          res.jsonLines([undefined]).catch(function (err) {
            res.status(500).type('application/json')
            res.json({ error: err.code })
          })
        })

        request(app)
          .get('/')
          .expect('Content-Type', 'application/json; charset=utf-8')
          .expect(500, { error: 'EXPRESS_JSON_LINES_UNDEFINED' }, done)
      })

      it('should destroy the response when the second record fails', async function () {
        var stream = fakeResponse(defaultSettings())
        var source = countingIterator([{ ok: 1 }, 10n, { never: true }])

        var promise = res.jsonLines.call(stream, source.iterator)
        await tick()
        await tick()
        stream.release()

        await assert.rejects(promise, function (err) {
          assert.strictEqual(err.code, 'EXPRESS_JSON_LINES_BIGINT')
          return true
        })
        // first record out, no partial second record, response destroyed
        assert.deepStrictEqual(stream.chunks, ['{"ok":1}\n'])
        assert.strictEqual(stream.destroyed, true)
        assert.strictEqual(source.calls.return, 1)
        assert.strictEqual(source.calls.next, 2)
      })

      it('should destroy the real response mid-stream without an error page', function (done) {
        var app = express()

        async function* rows () {
          yield { ok: 1 }
          // let the first record reach the client before failing
          await new Promise(function (resolve) { setTimeout(resolve, 50) })
          yield 10n
        }

        app.use(function (req, res) {
          res.jsonLines(rows()).catch(function () {})
        })

        var server = app.listen(0, function () {
          var client = http.get({ port: server.address().port, path: '/' }, function (res) {
            var body = ''
            res.on('data', function (chunk) { body += chunk })
            res.on('close', function () {
              assert.strictEqual(body, '{"ok":1}\n')
              server.close(done)
            })
          })
          client.on('error', function () {})
        })
      })
    })

    describe('client disconnect', function () {
      it('should settle once while waiting for drain and clean up listeners', async function () {
        var stream = fakeResponse(defaultSettings())
        var source = countingIterator([{ n: 1 }, { n: 2 }, { n: 3 }])

        var promise = res.jsonLines.call(stream, source.iterator)
        await tick()
        await tick()
        // stalled on backpressure
        assert.strictEqual(source.calls.next, 1)

        stream.destroy(new Error('client gone'))

        await assert.rejects(promise)
        assert.strictEqual(source.calls.return, 1)
        assert.strictEqual(source.calls.next, 1)
        assert.strictEqual(stream.listenerCount('drain'), 0)
        assert.strictEqual(stream.listenerCount('close'), 0)
        assert.strictEqual(stream.listenerCount('error'), 0)
      })

      it('should not write a late next() result after disconnect', async function () {
        var resolveNext
        var pending = new Promise(function (resolve) { resolveNext = resolve })
        var source = countingIterator([{ n: 1 }], {
          holdNextAt: 2,
          holdNextPromise: pending
        })

        // large highWaterMark so write() returns true and next() stays pending
        var writable = new Writable({
          highWaterMark: 1024,
          write: function (chunk, encoding, callback) {
            writable.chunks.push(chunk.toString())
            callback()
          }
        })
        writable.chunks = []
        writable.app = { get: function () { return undefined } }
        writable.req = { method: 'GET' }
        writable.headersSent = false
        writable.get = function () { return undefined }
        writable.set = function () { return writable }

        var promise = res.jsonLines.call(writable, source.iterator)
        await tick()
        await tick()
        assert.strictEqual(source.calls.next, 2)
        assert.deepStrictEqual(writable.chunks, ['{"n":1}\n'])

        writable.destroy(new Error('client gone'))
        await assert.rejects(promise)

        // the pending next() cannot be cancelled, but its late
        // result must not be written
        resolveNext({ done: false, value: { n: 2 } })
        await tick()
        await tick()
        assert.deepStrictEqual(writable.chunks, ['{"n":1}\n'])
      })

      it('should handle a rejecting iterator.return and still clean up', async function () {
        var stream = fakeResponse(defaultSettings())
        var source = countingIterator([{ n: 1 }, { n: 2 }], { returnRejects: true })

        var unhandled
        function onUnhandled (err) { unhandled = err }
        process.on('unhandledRejection', onUnhandled)

        var promise = res.jsonLines.call(stream, source.iterator)
        await tick()
        await tick()
        stream.destroy(new Error('client gone'))

        await assert.rejects(promise)
        await tick()
        await tick()
        process.removeListener('unhandledRejection', onUnhandled)

        assert.strictEqual(unhandled, undefined)
        assert.strictEqual(source.calls.return, 1)
        assert.strictEqual(stream.listenerCount('drain'), 0)
        assert.strictEqual(stream.listenerCount('close'), 0)
        assert.strictEqual(stream.listenerCount('error'), 0)
      })
    })

    describe('iterator errors', function () {
      it('should reject when next() throws and call return()', async function () {
        var stream = fakeResponse(defaultSettings())
        var boom = new Error('boom')
        var source = countingIterator([boom], { throwOn: boom })

        await assert.rejects(
          res.jsonLines.call(stream, source.iterator),
          function (err) {
            assert.strictEqual(err.message, 'boom')
            return true
          }
        )
        assert.strictEqual(source.calls.return, 1)
        assert.strictEqual(stream.destroyed, false)
      })

      it('should reject when next() rejects', async function () {
        var stream = fakeResponse(defaultSettings())
        var source = countingIterator([new Error('async boom')])

        await assert.rejects(
          res.jsonLines.call(stream, source.iterator),
          /async boom/
        )
        assert.strictEqual(source.calls.return, 1)
      })
    })

    describe('HEAD requests', function () {
      it('should send headers only and never consume the iterable', function (done) {
        var app = express()
        var consumed = 0

        app.use(function (req, res) {
          var iterable = {}
          iterable[Symbol.iterator] = function () {
            return {
              next: function () {
                consumed++
                return { done: true, value: undefined }
              }
            }
          }
          res.jsonLines(iterable).catch(done)
        })

        request(app)
          .head('/')
          .expect('Content-Type', 'application/x-ndjson; charset=utf-8')
          .expect(200)
          .expect(function (res) {
            assert.strictEqual(res.text, undefined)
            assert.strictEqual(consumed, 0)
          })
          .end(done)
      })
    })
  })
})
