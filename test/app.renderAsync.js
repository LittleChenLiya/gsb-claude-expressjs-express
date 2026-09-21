'use strict'

var assert = require('node:assert')
var express = require('..')
var path = require('node:path')
var tmpl = require('./support/tmpl')

var fixtures = path.join(__dirname, 'fixtures')

var unhandledRejections = []

function onUnhandledRejection(err) {
  unhandledRejections.push(err)
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}

describe('app', function () {
  describe('.renderAsync(name, options)', function () {
    before(function () {
      unhandledRejections.length = 0
      process.on('unhandledRejection', onUnhandledRejection)
    })

    after(function () {
      process.removeListener('unhandledRejection', onUnhandledRejection)
      assert.deepStrictEqual(unhandledRejections, [])
    })

    it('should resolve with the rendered string from a callback engine', async function () {
      var app = createApp()

      app.set('views', fixtures)

      var str = await app.renderAsync('user.tmpl', { user: { name: 'tobi' } })
      assert.strictEqual(str, '<p>tobi</p>')
    })

    it('should resolve with the rendered string from a promise engine', async function () {
      var app = express()

      app.engine('.fake', function (file, options) {
        return Promise.resolve('<p>' + options.user.name + '</p>')
      })
      app.set('views', fixtures)

      var str = await app.renderAsync('async.fake', { user: { name: 'tobi' } })
      assert.strictEqual(str, '<p>tobi</p>')
    })

    it('should reject when a callback engine errors', async function () {
      var app = createApp()

      app.set('views', fixtures)

      await assert.rejects(
        app.renderAsync('user.tmpl'),
        function (err) {
          assert.strictEqual(err.name, 'RenderError')
          return true
        }
      )
    })

    it('should reject when the engine throws synchronously', async function () {
      var app = express()

      app.engine('.fake', function () {
        throw new Error('boom')
      })
      app.set('views', fixtures)

      await assert.rejects(app.renderAsync('async.fake'), /boom/)
    })

    it('should reject when a promise engine rejects', async function () {
      var app = express()

      app.engine('.fake', function () {
        return Promise.reject(new Error('nope'))
      })
      app.set('views', fixtures)

      await assert.rejects(app.renderAsync('async.fake'), /nope/)
    })

    it('should reject when the view does not exist', async function () {
      var app = createApp()

      app.set('views', fixtures)

      await assert.rejects(
        app.renderAsync('rawr.tmpl'),
        new Error('Failed to lookup view "rawr.tmpl" in views directory "' + fixtures + '"')
      )
    })

    it('should honor the first completion when a callback precedes a late rejection', async function () {
      var app = express()

      app.engine('.fake', function (file, options, callback) {
        callback(null, 'first')
        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            reject(new Error('late rejection'))
          }, 10)
        })
      })
      app.set('views', fixtures)

      var str = await app.renderAsync('async.fake')
      assert.strictEqual(str, 'first')

      // let the late rejection settle; it must be consumed silently
      await delay(50)
      assert.deepStrictEqual(unhandledRejections, [])
    })

    it('should honor the first completion when an error precedes a late fulfillment', async function () {
      var app = express()

      app.engine('.fake', function (file, options, callback) {
        callback(new Error('first error'))
        return Promise.resolve('late success')
      })
      app.set('views', fixtures)

      await assert.rejects(app.renderAsync('async.fake'), /first error/)
    })

    it('should only complete once when the engine calls back repeatedly', async function () {
      var app = express()

      app.engine('.fake', function (file, options, callback) {
        callback(null, 'one')
        callback(null, 'two')
        callback(new Error('three'))
      })
      app.set('views', fixtures)

      var str = await app.renderAsync('async.fake')
      assert.strictEqual(str, 'one')
    })

    it('should not mutate the given options object', async function () {
      var app = createApp()

      app.set('views', fixtures)

      var options = { user: { name: 'tobi' } }
      var str = await app.renderAsync('user.tmpl', options)

      assert.strictEqual(str, '<p>tobi</p>')
      assert.deepStrictEqual(options, { user: { name: 'tobi' } })
    })

    it('should not mix up locals across concurrent renders of the same view', async function () {
      var app = express()

      app.engine('.fake', function (file, options, callback) {
        setTimeout(function () {
          callback(null, '<p>' + options.user.name + '</p>')
        }, Math.floor(Math.random() * 20))
      })
      app.set('views', fixtures)

      var renders = []
      for (var i = 0; i < 10; i++) {
        renders.push(app.renderAsync('async.fake', { user: { name: 'user' + i } }))
      }

      var results = await Promise.all(renders)
      for (var j = 0; j < 10; j++) {
        assert.strictEqual(results[j], '<p>user' + j + '</p>')
      }
    })

    it('should give precedence to render options over app.locals', async function () {
      var app = createApp()

      app.set('views', fixtures)
      app.locals.user = { name: 'tobi' }

      var str = await app.renderAsync('user.tmpl', { user: { name: 'jane' } })
      assert.strictEqual(str, '<p>jane</p>')
    })

    describe('caching', function () {
      function CountingView(name, options) {
        this.name = name
        this.path = 'fake'
        this.constructor.count++
      }

      it('should cache the view with "view cache" enabled', async function () {
        var app = express()

        CountingView.count = 0
        CountingView.prototype.render = function (options, fn) {
          fn(null, 'abstract engine')
        }

        app.set('view cache', true)
        app.set('view', CountingView)

        assert.strictEqual(await app.renderAsync('something'), 'abstract engine')
        assert.strictEqual(await app.renderAsync('something'), 'abstract engine')
        assert.strictEqual(CountingView.count, 1)
      })

      it('should lookup the view every time without cache', async function () {
        var app = express()

        CountingView.count = 0
        CountingView.prototype.render = function (options, fn) {
          fn(null, 'abstract engine')
        }

        app.set('view cache', false)
        app.set('view', CountingView)

        assert.strictEqual(await app.renderAsync('something'), 'abstract engine')
        assert.strictEqual(await app.renderAsync('something'), 'abstract engine')
        assert.strictEqual(CountingView.count, 2)
      })
    })

    describe('sub-apps', function () {
      it('should keep views and engines of parent and child isolated', async function () {
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

        parent.use('/sub', child)

        var parentStr = await parent.renderAsync('page.fake', { user: { name: 'tobi' } })
        var childStr = await child.renderAsync('page.fake', { user: { name: 'tobi' } })

        assert.strictEqual(parentStr, 'parent:tobi')
        assert.strictEqual(childStr, 'child:tobi')
      })
    })
  })

  describe('.render(name, fn) with a promise engine', function () {
    before(function () {
      unhandledRejections.length = 0
      process.on('unhandledRejection', onUnhandledRejection)
    })

    after(function () {
      process.removeListener('unhandledRejection', onUnhandledRejection)
      assert.deepStrictEqual(unhandledRejections, [])
    })

    it('should invoke the callback with the resolved string', function (done) {
      var app = express()

      app.engine('.fake', function (file, options) {
        return Promise.resolve('<p>' + options.user.name + '</p>')
      })
      app.set('views', fixtures)

      app.render('async.fake', { user: { name: 'tobi' } }, function (err, str) {
        if (err) return done(err)
        assert.strictEqual(str, '<p>tobi</p>')
        done()
      })
    })

    it('should invoke the callback with the rejection error', function (done) {
      var app = express()

      app.engine('.fake', function () {
        return Promise.reject(new Error('nope'))
      })
      app.set('views', fixtures)

      app.render('async.fake', function (err, str) {
        assert.ok(err)
        assert.strictEqual(err.message, 'nope')
        assert.strictEqual(str, undefined)
        done()
      })
    })

    it('should consume a late rejection after a callback completion', function (done) {
      var app = express()

      app.engine('.fake', function (file, options, callback) {
        callback(null, 'first')
        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            reject(new Error('late rejection'))
          }, 10)
        })
      })
      app.set('views', fixtures)

      app.render('async.fake', function (err, str) {
        if (err) return done(err)
        assert.strictEqual(str, 'first')
        setTimeout(function () {
          assert.deepStrictEqual(unhandledRejections, [])
          done()
        }, 50)
      })
    })
  })
})

function createApp() {
  var app = express()

  app.engine('.tmpl', tmpl)

  return app
}
