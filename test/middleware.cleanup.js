'use strict'

var assert = require('node:assert')
var http = require('node:http')
var express = require('../')
var request = require('supertest')

function until (cond) {
  return new Promise(function (resolve, reject) {
    var timer = setInterval(function () {
      if (cond()) {
        clearInterval(timer)
        clearTimeout(timeout)
        resolve()
      }
    }, 5)
    var timeout = setTimeout(function () {
      clearInterval(timer)
      reject(new Error('timed out waiting for condition'))
    }, 3000)
  })
}

function listen (app) {
  return new Promise(function (resolve) {
    var server = app.listen(0, function () {
      resolve(server)
    })
  })
}

describe('express.cleanup()', function () {
  it('should reject a non-function onError option', function () {
    assert.throws(function () {
      express.cleanup({ onError: 'nope' })
    }, /TypeError: option onError must be a function/)
  })

  it('should run cleaners in reverse order after a normal response', async function () {
    var calls = []
    var app = express()

    app.use(express.cleanup())
    app.get('/', function (req, res) {
      req.registerCleanup(function () { calls.push('A') })
      req.registerCleanup(function () { calls.push('B') })
      res.send('ok')
    })

    await request(app).get('/').expect(200, 'ok')
    await until(function () { return calls.length === 2 })
    assert.deepStrictEqual(calls, ['B', 'A'])
  })

  it('should continue after a failing cleaner and aggregate errors', async function () {
    var calls = []
    var errors = null
    var app = express()

    app.use(express.cleanup({
      onError: function (errs) { errors = errs }
    }))
    app.get('/', function (req, res) {
      req.registerCleanup(function () { calls.push('A') })
      req.registerCleanup(function () {
        calls.push('B')
        throw new Error('boom-B')
      })
      res.send('ok')
    })

    await request(app).get('/').expect(200, 'ok')
    await until(function () { return calls.length === 2 && errors !== null })
    assert.deepStrictEqual(calls, ['B', 'A'])
    assert.strictEqual(errors.length, 1)
    assert.strictEqual(errors[0].message, 'boom-B')
  })

  it('should aggregate async rejections too', async function () {
    var calls = []
    var errors = null
    var app = express()

    app.use(express.cleanup({
      onError: function (errs) { errors = errs }
    }))
    app.get('/', function (req, res) {
      req.registerCleanup(async function () { calls.push('A') })
      req.registerCleanup(async function () {
        calls.push('B')
        throw new Error('async-boom')
      })
      res.send('ok')
    })

    await request(app).get('/').expect(200, 'ok')
    await until(function () { return calls.length === 2 && errors !== null })
    assert.deepStrictEqual(calls, ['B', 'A'])
    assert.strictEqual(errors.length, 1)
    assert.strictEqual(errors[0].message, 'async-boom')
  })

  it('should run cleaners once when the client aborts the connection', async function () {
    var calls = []
    var app = express()

    app.use(express.cleanup())
    app.get('/', function (req, res) {
      req.registerCleanup(function () { calls.push('A') })
      req.registerCleanup(function () { calls.push('B') })
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.write('partial')
      // never end: the client will abort
    })

    var server = await listen(app)
    var port = server.address().port

    await new Promise(function (resolve, reject) {
      var req = http.get({ port: port, path: '/' }, function (res) {
        res.on('data', function () {
          req.destroy() // abort mid-response
          resolve()
        })
      })
      req.on('error', function () {})
    })

    await until(function () { return calls.length === 2 })
    await new Promise(function (resolve) { setTimeout(resolve, 50) })
    assert.deepStrictEqual(calls, ['B', 'A'])
    server.close()
  })

  it('should await async cleaners and run only once when finish and close race', async function () {
    var calls = []
    var release
    var gate = new Promise(function (resolve) { release = resolve })
    var app = express()

    app.use(express.cleanup())
    app.get('/', function (req, res) {
      req.registerCleanup(async function () {
        calls.push('A-start')
        await gate
        calls.push('A-end')
      })
      res.send('ok')
    })

    var server = await listen(app)
    var port = server.address().port

    await new Promise(function (resolve, reject) {
      http.get({ port: port, path: '/' }, function (res) {
        var socket = res.socket
        res.resume()
        res.on('end', function () {
          socket.destroy() // force "close" after "finish"
          resolve()
        })
      }).on('error', reject)
    })

    // cleanup started, but must be waiting on the pending promise
    await until(function () { return calls.indexOf('A-start') !== -1 })
    await new Promise(function (resolve) { setTimeout(resolve, 50) })
    assert.deepStrictEqual(calls, ['A-start'])

    // release the controllable promise: now it completes
    release()
    await until(function () { return calls.indexOf('A-end') !== -1 })
    await new Promise(function (resolve) { setTimeout(resolve, 50) })
    assert.deepStrictEqual(calls, ['A-start', 'A-end'])
    server.close()
  })

  it('should reject registration once cleanup has started', async function () {
    var calls = []
    var app = express()

    app.use(express.cleanup())
    app.get('/', function (req, res) {
      req.registerCleanup(function () {
        try {
          req.registerCleanup(function () {})
          calls.push('accepted')
        } catch (err) {
          calls.push('rejected: ' + err.message)
        }
      })
      res.send('ok')
    })

    await request(app).get('/').expect(200, 'ok')
    await until(function () { return calls.length === 1 })
    assert.deepStrictEqual(calls, ['rejected: cannot register cleanup: cleanup already started'])
  })

  it('should run cleaners when the route errors out', async function () {
    var calls = []
    var app = express()

    app.use(express.cleanup())
    app.get('/', function (req, res, next) {
      req.registerCleanup(function () { calls.push('A') })
      next(new Error('route failed'))
    })
    app.use(function (err, req, res, next) {
      res.status(500).send('handled')
    })

    await request(app).get('/').expect(500, 'handled')
    await until(function () { return calls.length === 1 })
    assert.deepStrictEqual(calls, ['A'])
  })

  it('should leave requests without the middleware untouched', async function () {
    var app = express()

    app.get('/', function (req, res) {
      assert.strictEqual(req.registerCleanup, undefined)
      res.send('ok')
    })

    await request(app).get('/').expect(200, 'ok')
  })
})
