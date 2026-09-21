'use strict'

var assert = require('node:assert')
var express = require('..')
var path = require('node:path')
var tmpl = require('./support/tmpl')

var fixtures = path.join(__dirname, 'fixtures')

// promise engine: resolves with the rendered string
function promiseEngine(file, options) {
  return Promise.resolve('<p>' + options.user.name + '</p>')
}

// callback engine that also returns a promise rejecting later
function callbackThenLateRejectEngine(file, options, fn) {
  fn(null, '<p>' + options.user.name + '</p>')
  return new Promise(function (resolve, reject) {
    setTimeout(function () { reject(new Error('late rejection')) }, 10)
  })
}

// engine that calls the callback twice
function doubleCallbackEngine(file, options, fn) {
  fn(null, 'first')
  fn(null, 'second')
}

// engine that throws synchronously
function syncThrowEngine(file, options, fn) {
  throw new Error('sync boom')
}

// engine that only returns a rejecting promise
function rejectingEngine(file, options) {
  return Promise.reject(new Error('promise boom'))
}

function createApp(engine) {
  var app = express()

  app.set('views', fixtures)
  app.engine('.tmpl', engine || tmpl)

  return app
}

function watchUnhandledRejection() {
  var rejections = []
  function onUnhandled(err) { rejections.push(err) }
  process.on('unhandledRejection', onUnhandled)
  return {
    rejections: rejections,
    stop: function () { process.removeListener('unhandledRejection', onUnhandled) }
  }
}

describe('app', function () {
  describe('.renderAsync(name)', function () {
    it('should render with a callback engine', async function () {
      var app = createApp()

      var str = await app.renderAsync('user.tmpl', { user: { name: 'tobi' } })
      assert.strictEqual(str, '<p>tobi</p>')
    })

    it('should render with a promise engine', async function () {
      var app = createApp(promiseEngine)

      var str = await app.renderAsync('user.tmpl', { user: { name: 'tobi' } })
      assert.strictEqual(str, '<p>tobi</p>')
    })

    it('should reject when the engine throws synchronously', async function () {
      var app = createApp(syncThrowEngine)

      await assert.rejects(app.renderAsync('user.tmpl'), /sync boom/)
    })

    it('should reject when the promise engine rejects', async function () {
      var app = createApp(rejectingEngine)

      await assert.rejects(app.renderAsync('user.tmpl'), /promise boom/)
    })

    it('should reject when the view does not exist', async function () {
      var app = createApp()

      await assert.rejects(
        app.renderAsync('rawr.tmpl'),
        new RegExp('Failed to lookup view "rawr.tmpl"')
      )
    })

    it('should settle once when the engine completes twice', async function () {
      var app = createApp(doubleCallbackEngine)

      var str = await app.renderAsync('user.tmpl')
      assert.strictEqual(str, 'first')
    })

    it('should consume late promise rejections after callback completion', async function () {
      var app = createApp(callbackThenLateRejectEngine)
      var watcher = watchUnhandledRejection()

      try {
        var str = await app.renderAsync('user.tmpl', { user: { name: 'tobi' } })
        assert.strictEqual(str, '<p>tobi</p>')

        // allow the late rejection to fire
        await new Promise(function (resolve) { setTimeout(resolve, 50) })
        assert.deepStrictEqual(watcher.rejections, [])
      } finally {
        watcher.stop()
      }
    })

    it('should not modify the passed options object', async function () {
      var app = createApp()
      var options = { user: { name: 'tobi' } }

      await app.renderAsync('user.tmpl', options)
      assert.deepStrictEqual(options, { user: { name: 'tobi' } })
    })

    it('should give precedence to render options over app.locals', async function () {
      var app = createApp()

      app.locals.user = { name: 'jane' }

      var str = await app.renderAsync('user.tmpl', { user: { name: 'tobi' } })
      assert.strictEqual(str, '<p>tobi</p>')
    })

    it('should expose app.locals', async function () {
      var app = createApp()

      app.locals.user = { name: 'tobi' }

      var str = await app.renderAsync('user.tmpl')
      assert.strictEqual(str, '<p>tobi</p>')
    })

    it('should not mix locals between concurrent renders of one view', async function () {
      var app = createApp()

      app.set('view cache', true)

      var results = await Promise.all([
        app.renderAsync('user.tmpl', { user: { name: 'tobi' } }),
        app.renderAsync('user.tmpl', { user: { name: 'jane' } }),
        app.renderAsync('user.tmpl', { user: { name: 'loki' } })
      ])

      assert.deepStrictEqual(results, ['<p>tobi</p>', '<p>jane</p>', '<p>loki</p>'])
    })

    describe('view cache', function () {
      it('should cache the view when "view cache" is enabled', async function () {
        var app = createApp()

        app.set('view cache', true)

        await app.renderAsync('user.tmpl', { user: { name: 'tobi' } })
        assert.ok(app.cache['user.tmpl'])

        var str = await app.renderAsync('user.tmpl', { user: { name: 'jane' } })
        assert.strictEqual(str, '<p>jane</p>')
      })

      it('should not cache the view when "view cache" is disabled', async function () {
        var app = createApp()

        app.set('view cache', false)

        await app.renderAsync('user.tmpl', { user: { name: 'tobi' } })
        assert.strictEqual(app.cache['user.tmpl'], undefined)
      })
    })

    describe('sub-apps', function () {
      it('should isolate views and engines between parent and child', async function () {
        var app = createApp()
        var child = express()

        child.set('views', path.join(fixtures, 'child'))
        child.engine('.tmpl', tmpl)

        app.use(child)

        var parentStr = await app.renderAsync('user.tmpl', { user: { name: 'tobi' } })
        var childStr = await child.renderAsync('user.tmpl', { user: { name: 'tobi' } })

        assert.strictEqual(parentStr, '<p>tobi</p>')
        assert.strictEqual(childStr, '<p>child:tobi</p>')
      })
    })
  })

  describe('.render(name, options, fn) with promise engines', function () {
    it('should support engines returning a promise', function (done) {
      var app = createApp(promiseEngine)

      app.render('user.tmpl', { user: { name: 'tobi' } }, function (err, str) {
        if (err) return done(err)
        assert.strictEqual(str, '<p>tobi</p>')
        done()
      })
    })

    it('should report promise rejections through the callback', function (done) {
      var app = createApp(rejectingEngine)

      app.render('user.tmpl', function (err, str) {
        assert.ok(err)
        assert.strictEqual(err.message, 'promise boom')
        assert.strictEqual(str, undefined)
        done()
      })
    })

    it('should report synchronous engine throws through the callback', function (done) {
      var app = createApp(syncThrowEngine)

      app.render('user.tmpl', function (err, str) {
        assert.ok(err)
        assert.strictEqual(err.message, 'sync boom')
        done()
      })
    })

    it('should invoke the callback once for double-completing engines', function (done) {
      var app = createApp(callbackThenLateRejectEngine)
      var watcher = watchUnhandledRejection()
      var calls = 0

      app.render('user.tmpl', { user: { name: 'tobi' } }, function (err, str) {
        calls++
        assert.ifError(err)
        assert.strictEqual(str, '<p>tobi</p>')

        setTimeout(function () {
          watcher.stop()
          assert.strictEqual(calls, 1)
          assert.deepStrictEqual(watcher.rejections, [])
          done()
        }, 50)
      })
    })
  })
})
