'use strict'

var assert = require('node:assert')
var express = require('..')
var http = require('node:http')
var path = require('node:path')
var request = require('supertest')
var tmpl = require('./support/tmpl')

var fixtures = path.join(__dirname, 'fixtures')

// promise engine: resolves with the rendered string
function promiseEngine(file, options) {
  return Promise.resolve('<p>' + options.user.name + '</p>')
}

// slow promise engine for abort tests
function slowPromiseEngine(file, options) {
  return new Promise(function (resolve) {
    setTimeout(function () { resolve('<p>slow</p>') }, 50)
  })
}

// engine that calls the callback twice
function doubleCallbackEngine(file, options, fn) {
  fn(null, 'first')
  fn(null, 'second')
}

function createApp(engine) {
  var app = express()

  app.set('views', fixtures)
  app.engine('.tmpl', engine || tmpl)

  return app
}

describe('res', function () {
  describe('.renderAsync(name)', function () {
    it('should render and send with a callback engine', function (done) {
      var app = createApp()

      app.use(function (req, res) {
        res.renderAsync('user.tmpl', { user: { name: 'tobi' } }).catch(req.next)
      })

      request(app)
        .get('/')
        .expect('Content-Type', /html/)
        .expect(200, '<p>tobi</p>', done)
    })

    it('should render and send with a promise engine', function (done) {
      var app = createApp(promiseEngine)

      app.use(function (req, res) {
        res.renderAsync('user.tmpl', { user: { name: 'tobi' } }).catch(req.next)
      })

      request(app)
        .get('/')
        .expect(200, '<p>tobi</p>', done)
    })

    it('should resolve with the rendered string after sending', function (done) {
      var app = createApp()

      app.use(function (req, res) {
        res.renderAsync('user.tmpl', { user: { name: 'tobi' } })
          .then(function (str) {
            assert.strictEqual(str, '<p>tobi</p>')
            assert.ok(res.headersSent)
          })
          .catch(req.next)
      })

      request(app)
        .get('/')
        .expect(200, '<p>tobi</p>', done)
    })

    it('should reject instead of calling next() on render errors', function (done) {
      var app = createApp()
      var errorMiddlewareCalled = false

      app.use(function (req, res) {
        res.renderAsync('missing.tmpl')
          .catch(function (err) {
            assert.ok(/Failed to lookup view "missing.tmpl"/.test(err.message))
            res.status(500).send('caught: ' + err.message)
          })
      })

      app.use(function (err, req, res, next) {
        errorMiddlewareCalled = true
        res.status(500).send('middleware: ' + err.message)
      })

      request(app)
        .get('/')
        .expect(500, /caught: /, function (err) {
          if (err) return done(err)
          assert.strictEqual(errorMiddlewareCalled, false)
          done()
        })
    })

    it('should not modify the passed options object', function (done) {
      var app = createApp()
      var options = { user: { name: 'tobi' } }

      app.use(function (req, res) {
        res.locals.user = { name: 'jane' }
        res.renderAsync('user.tmpl', options)
          .then(function () {
            assert.deepStrictEqual(options, { user: { name: 'tobi' } })
          })
          .catch(req.next)
      })

      request(app)
        .get('/')
        .expect(200, '<p>tobi</p>', done)
    })

    it('should merge res.locals', function (done) {
      var app = createApp()

      app.use(function (req, res) {
        res.locals.user = { name: 'tobi' }
        res.renderAsync('user.tmpl').catch(req.next)
      })

      request(app)
        .get('/')
        .expect(200, '<p>tobi</p>', done)
    })

    it('should give precedence to options over res.locals and app.locals', function (done) {
      var app = createApp()

      app.locals.user = { name: 'loki' }

      app.use(function (req, res) {
        res.locals.user = { name: 'jane' }
        res.renderAsync('user.tmpl', { user: { name: 'tobi' } }).catch(req.next)
      })

      request(app)
        .get('/')
        .expect(200, '<p>tobi</p>', done)
    })

    it('should send only once for double-completing engines', function (done) {
      var app = createApp(doubleCallbackEngine)

      app.use(function (req, res) {
        res.renderAsync('user.tmpl').catch(req.next)
      })

      request(app)
        .get('/')
        .expect(200, 'first', done)
    })

    it('should reject when the client closes the connection mid-render', function (done) {
      var app = createApp(slowPromiseEngine)
      var renderError = null

      app.use(function (req, res) {
        res.renderAsync('user.tmpl').catch(function (err) {
          renderError = err
        })
      })

      var server = app.listen(0, function () {
        var port = server.address().port
        var req = http.get({ port: port, path: '/' }, function () {})

        req.on('error', function () {})

        setTimeout(function () {
          req.destroy()
        }, 10)

        setTimeout(function () {
          server.close(function () {
            assert.ok(renderError)
            assert.strictEqual(renderError.code, 'ECONNABORTED')
            done()
          })
        }, 200)
      })
    })

    it('should isolate views and engines for mounted sub-apps', function (done) {
      var app = createApp()
      var child = express()

      child.set('views', path.join(fixtures, 'child'))
      child.engine('.tmpl', tmpl)

      child.use(function (req, res) {
        res.renderAsync('user.tmpl', { user: { name: 'tobi' } }).catch(req.next)
      })

      app.use('/child', child)
      app.use(function (req, res) {
        res.renderAsync('user.tmpl', { user: { name: 'tobi' } }).catch(req.next)
      })

      request(app)
        .get('/child/')
        .expect(200, '<p>child:tobi</p>', function (err) {
          if (err) return done(err)
          request(app)
            .get('/')
            .expect(200, '<p>tobi</p>', done)
        })
    })
  })
})
