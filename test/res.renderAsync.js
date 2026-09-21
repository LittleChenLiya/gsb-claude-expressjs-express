'use strict'

var assert = require('node:assert')
var express = require('..')
var http = require('node:http')
var path = require('node:path')
var request = require('supertest')
var tmpl = require('./support/tmpl')

var fixtures = path.join(__dirname, 'fixtures')

var unhandledRejections = []

function onUnhandledRejection(err) {
  unhandledRejections.push(err)
}

describe('res', function () {
  describe('.renderAsync(name, options)', function () {
    before(function () {
      unhandledRejections.length = 0
      process.on('unhandledRejection', onUnhandledRejection)
    })

    after(function () {
      process.removeListener('unhandledRejection', onUnhandledRejection)
      assert.deepStrictEqual(unhandledRejections, [])
    })

    it('should send the rendered string and resolve with it', function (done) {
      var app = createApp()
      var resolved

      app.set('views', fixtures)

      app.use(function (req, res) {
        res.renderAsync('user.tmpl', { user: { name: 'tobi' } }).then(function (str) {
          resolved = str
        }, done)
      })

      request(app)
        .get('/')
        .expect('<p>tobi</p>', function (err) {
          if (err) return done(err)
          assert.strictEqual(resolved, '<p>tobi</p>')
          done()
        })
    })

    it('should work with a promise-returning engine', function (done) {
      var app = express()

      app.engine('.fake', function (file, options) {
        return Promise.resolve('<p>' + options.user.name + '</p>')
      })
      app.set('views', fixtures)

      app.use(function (req, res) {
        res.renderAsync('async.fake', { user: { name: 'tobi' } }).catch(done)
      })

      request(app)
        .get('/')
        .expect('<p>tobi</p>', done)
    })

    it('should reject on render error without calling next(err)', function (done) {
      var app = createApp()
      var errorMiddlewareCalled = false

      app.set('views', fixtures)

      app.use(function (req, res) {
        res.renderAsync('user.tmpl').then(function () {
          res.end('unexpected')
        }, function (err) {
          assert.strictEqual(err.name, 'RenderError')
          res.status(500).end('caught: ' + err.name)
        })
      })

      app.use(function (err, req, res, next) {
        errorMiddlewareCalled = true
        res.status(500).end('error middleware')
      })

      request(app)
        .get('/')
        .expect(500, 'caught: RenderError', function (err) {
          if (err) return done(err)
          assert.strictEqual(errorMiddlewareCalled, false)
          done()
        })
    })

    it('should reject when the view does not exist', function (done) {
      var app = createApp()

      app.set('views', fixtures)

      app.use(function (req, res) {
        res.renderAsync('rawr.tmpl').then(function () {
          res.end('unexpected')
        }, function (err) {
          res.status(500).end('caught: ' + err.message)
        })
      })

      request(app)
        .get('/')
        .expect(500, 'caught: Failed to lookup view "rawr.tmpl" in views directory "' + fixtures + '"', done)
    })

    it('should not mutate the given options object', function (done) {
      var app = createApp()
      var options = { user: { name: 'tobi' } }

      app.set('views', fixtures)

      app.use(function (req, res) {
        res.renderAsync('user.tmpl', options).catch(done)
      })

      request(app)
        .get('/')
        .expect('<p>tobi</p>', function (err) {
          if (err) return done(err)
          assert.deepStrictEqual(options, { user: { name: 'tobi' } })
          done()
        })
    })

    it('should merge res.locals and give precedence to options', function (done) {
      var app = createApp()

      app.set('views', fixtures)

      app.use(function (req, res) {
        res.locals.user = { name: 'tobi' }
        res.renderAsync('user.tmpl', { user: { name: 'jane' } }).catch(done)
      })

      request(app)
        .get('/')
        .expect('<p>jane</p>', done)
    })

    it('should expose res.locals when no options are given', function (done) {
      var app = createApp()

      app.set('views', fixtures)

      app.use(function (req, res) {
        res.locals.user = { name: 'tobi' }
        res.renderAsync('user.tmpl').catch(done)
      })

      request(app)
        .get('/')
        .expect('<p>tobi</p>', done)
    })

    it('should not mix up locals across concurrent requests', async function () {
      var app = express()

      app.engine('.fake', function (file, options, callback) {
        setTimeout(function () {
          callback(null, '<p>' + options.user.name + '</p>')
        }, Math.floor(Math.random() * 20))
      })
      app.set('views', fixtures)

      app.use(function (req, res) {
        res.locals.user = { name: req.query.name }
        res.renderAsync('async.fake').catch(function () {
          res.status(500).end('error')
        })
      })

      var requests = []
      for (var i = 0; i < 10; i++) {
        requests.push(request(app).get('/?name=user' + i))
      }

      var responses = await Promise.all(requests)
      for (var j = 0; j < 10; j++) {
        assert.strictEqual(responses[j].text, '<p>user' + j + '</p>')
      }
    })

    it('should send only once when the engine completes twice', function (done) {
      var app = express()

      app.engine('.fake', function (file, options, callback) {
        callback(null, 'first')
        callback(null, 'second')
        return Promise.resolve('third')
      })
      app.set('views', fixtures)

      app.use(function (req, res) {
        res.renderAsync('async.fake').catch(done)
      })

      request(app)
        .get('/')
        .expect('first', done)
    })

    it('should reject when the client closes the connection mid-render', function (done) {
      var app = express()
      var renderError
      var response

      app.engine('.fake', function (file, options, callback) {
        setTimeout(function () {
          callback(null, 'late result')
        }, 100)
      })
      app.set('views', fixtures)

      app.use(function (req, res) {
        response = res
        res.renderAsync('async.fake').then(function () {
          renderError = new Error('resolved unexpectedly')
        }, function (err) {
          renderError = err
        })
      })

      var server = app.listen(0, function () {
        var port = server.address().port
        var req = http.get({ port: port, path: '/' }, function () {})

        req.on('error', function () {})

        setTimeout(function () {
          req.destroy()
        }, 20)

        setTimeout(function () {
          assert.ok(renderError)
          assert.strictEqual(renderError.code, 'ECONNABORTED')
          assert.strictEqual(response.writableEnded, false)
          server.close(done)
        }, 300)
      })
    })

    describe('sub-apps', function () {
      it('should keep views and engines of parent and child isolated', function (done) {
        var parent = express()
        var child = express()

        parent.engine('.fake', function (file, options, callback) {
          callback(null, 'parent:' + options.user.name)
        })
        parent.set('views', path.join(fixtures, 'parent'))

        child.engine('.fake', function (file, options, callback) {
          callback(null, 'child:' + options.user.name)
        })
        child.set('views', path.join(fixtures, 'child'))

        parent.get('/page', function (req, res) {
          res.renderAsync('page.fake', { user: { name: 'tobi' } }).catch(done)
        })

        child.get('/page', function (req, res) {
          res.renderAsync('page.fake', { user: { name: 'tobi' } }).catch(done)
        })

        parent.use('/sub', child)

        request(parent)
          .get('/page')
          .expect('parent:tobi', function (err) {
            if (err) return done(err)
            request(parent)
              .get('/sub/page')
              .expect('child:tobi', done)
          })
      })
    })
  })

  describe('.render(name) with a promise engine', function () {
    it('should send the resolved string with the default callback', function (done) {
      var app = express()

      app.engine('.fake', function (file, options) {
        return Promise.resolve('<p>' + options.user.name + '</p>')
      })
      app.set('views', fixtures)

      app.use(function (req, res) {
        res.locals.user = { name: 'tobi' }
        res.render('async.fake')
      })

      request(app)
        .get('/')
        .expect('<p>tobi</p>', done)
    })

    it('should forward rejections to next(err) with the default callback', function (done) {
      var app = express()

      app.engine('.fake', function () {
        return Promise.reject(new Error('nope'))
      })
      app.set('views', fixtures)

      app.use(function (req, res) {
        res.render('async.fake')
      })

      app.use(function (err, req, res, next) {
        res.status(500).end('error middleware: ' + err.message)
      })

      request(app)
        .get('/')
        .expect(500, 'error middleware: nope', done)
    })
  })
})

function createApp() {
  var app = express()

  app.engine('.tmpl', tmpl)

  return app
}
