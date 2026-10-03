'use strict'

var assert = require('node:assert')
var express = require('..')
var request = require('supertest')

describe('express.ifMatch()', function () {
  // The "current" strong tag of the target resource. It deliberately
  // contains a comma inside the quoted string to prove that commas inside
  // quoted tags are not treated as list separators.
  var CURRENT_TAG = '"a,b"'

  describe('positive matches', function () {
    it('should call next() on an exact strong match', function (done) {
      var app = createApp({ current: CURRENT_TAG })

      request(app)
        .put('/items/1')
        .set('If-Match', CURRENT_TAG)
        .expect(200, 'updated', done)
    })

    it('should parse a comma inside a quoted tag as tag content', function (done) {
      var app = createApp({ current: CURRENT_TAG })

      request(app)
        .put('/items/1')
        .set('If-Match', '"x,y" , "a,b"')
        .expect(200, 'updated', done)
    })

    it('should pass when the matching tag is first in a list', function (done) {
      var app = createApp({ current: CURRENT_TAG })

      request(app)
        .put('/items/1')
        .set('If-Match', '"a,b", "other"')
        .expect(200, 'updated', done)
    })

    it('should tolerate OWS around tags and commas', function (done) {
      var app = createApp({ current: CURRENT_TAG })

      request(app)
        .put('/items/1')
        .set('If-Match', '\t"nope"\t,\t"a,b"\t')
        .expect(200, 'updated', done)
    })

    it('should pass "*" when the resource exists', function (done) {
      var app = createApp({ current: CURRENT_TAG })

      request(app)
        .put('/items/1')
        .set('If-Match', '*')
        .expect(200, 'updated', done)
    })

    it('should pass "*" even when the current validator is weak', function (done) {
      // The wildcard only requires existence; weak validators still exist.
      var app = createApp({ current: 'W/"a,b"' })

      request(app)
        .put('/items/1')
        .set('If-Match', '*')
        .expect(200, 'updated', done)
    })

    it('should expose the queried tag as req.currentEtag', function (done) {
      var app = createApp({
        current: CURRENT_TAG,
        onPass: function (req) {
          assert.strictEqual(req.currentEtag, CURRENT_TAG)
        }
      })

      request(app)
        .put('/items/1')
        .set('If-Match', CURRENT_TAG)
        .expect(200, done)
    })
  })

  describe('failed preconditions (412)', function () {
    it('should reject a non-matching strong tag', function (done) {
      var app = createApp({ current: CURRENT_TAG })

      request(app)
        .put('/items/1')
        .set('If-Match', '"stale"')
        .expect(412, done)
    })

    it('should reject a weak tag equal to the current strong tag', function (done) {
      var app = createApp({ current: CURRENT_TAG })

      request(app)
        .put('/items/1')
        .set('If-Match', 'W/"a,b"')
        .expect(412, done)
    })

    it('should reject a weak tag embedded in a list of strong tags', function (done) {
      var app = createApp({ current: CURRENT_TAG })

      // "a,b" only appears as W/"a,b", which never matches strongly.
      request(app)
        .put('/items/1')
        .set('If-Match', '"x", W/"a,b", "y"')
        .expect(412, done)
    })

    it('should reject "*" when the resource does not exist', function (done) {
      var app = createApp({ current: null })

      request(app)
        .put('/items/1')
        .set('If-Match', '*')
        .expect(412, done)
    })

    it('should reject a tag match when the resource does not exist', function (done) {
      var app = createApp({ current: null })

      request(app)
        .put('/items/1')
        .set('If-Match', CURRENT_TAG)
        .expect(412, done)
    })

    it('should not run the handler on a 412 path', function (done) {
      var app = createApp({ current: CURRENT_TAG })

      request(app)
        .put('/items/1')
        .set('If-Match', '"nope"')
        .expect(412)
        .end(function (err) {
          if (err) return done(err)
          assert.strictEqual(app.locals.handlerCalls, 0)
          done()
        })
    })
  })

  describe('missing header (428)', function () {
    it('should call next() without a header by default', function (done) {
      var app = createApp({ current: CURRENT_TAG })

      request(app)
        .put('/items/1')
        .expect(200, 'updated', done)
    })

    it('should 428 without a header when requireHeader is true', function (done) {
      var app = createApp({ current: CURRENT_TAG, requireHeader: true })

      request(app)
        .put('/items/1')
        .expect(428, done)
    })

    it('should not run the handler on a 428 path', function (done) {
      var app = createApp({ current: CURRENT_TAG, requireHeader: true })

      request(app)
        .put('/items/1')
        .expect(428)
        .end(function (err) {
          if (err) return done(err)
          assert.strictEqual(app.locals.handlerCalls, 0)
          done()
        })
    })
  })

  describe('malformed header (400)', function () {
    var invalid = [
      '"unterminated',
      'not-quoted',
      '"x",',
      ', "x"',
      '"x" "y"',
      '"x", , "y"',
      '**',
      '*, "x"',
      'w/"x"',
      'W /"x"',
      '"x" extra',
      ''
    ]

    invalid.forEach(function (headerValue) {
      it('should 400 for ' + JSON.stringify(headerValue), function (done) {
        var app = createApp({ current: CURRENT_TAG })

        request(app)
          .put('/items/1')
          .set('If-Match', headerValue)
          .expect(400)
          .end(function (err) {
            if (err) return done(err)
            assert.strictEqual(app.locals.handlerCalls, 0)
            done()
          })
      })
    })
  })

  describe('current-tag provider', function () {
    it('should query the current ETag at most once', function (done) {
      var queries = 0
      var app = express()

      app.put('/items/:id', express.ifMatch({
        etag: function (req) {
          queries += 1
          return Promise.resolve(CURRENT_TAG)
        }
      }), function (req, res) {
        res.status(200).send('updated')
      })

      request(app)
        .put('/items/1')
        .set('If-Match', '"first", "a,b"')
        .expect(200)
        .end(function (err) {
          if (err) return done(err)
          assert.strictEqual(queries, 1)
          done()
        })
    })

    it('should not query the provider when the header is missing by default', function (done) {
      var queries = 0
      var app = express()

      app.put('/items/:id', express.ifMatch({
        etag: function (req, cb) {
          queries += 1
          cb(null, CURRENT_TAG)
        }
      }), function (req, res) {
        res.status(200).send('updated')
      })

      request(app)
        .put('/items/1')
        .expect(200)
        .end(function (err) {
          if (err) return done(err)
          assert.strictEqual(queries, 0)
          done()
        })
    })

    it('should not query the provider when the header is malformed', function (done) {
      var queries = 0
      var app = express()

      app.put('/items/:id', express.ifMatch({
        etag: function (req) {
          queries += 1
          return Promise.resolve(CURRENT_TAG)
        }
      }), function (req, res) {
        res.status(200).send('updated')
      })

      request(app)
        .put('/items/1')
        .set('If-Match', '"broken')
        .expect(400)
        .end(function (err) {
          if (err) return done(err)
          assert.strictEqual(queries, 0)
          done()
        })
    })

    it('should propagate a rejected promise (not 412)', function (done) {
      var app = createApp({ current: new Error('store down') })

      request(app)
        .put('/items/1')
        .set('If-Match', CURRENT_TAG)
        .expect(500, done)
    })

    it('should propagate a thrown provider error (not 412)', function (done) {
      var app = express()

      app.put('/items/:id', express.ifMatch({
        etag: function () {
          throw new Error('store down')
        }
      }), function (req, res) {
        res.status(200).send('updated')
      })

      request(app)
        .put('/items/1')
        .set('If-Match', CURRENT_TAG)
        .expect(500, done)
    })

    it('should propagate a node-callback provider error (not 412)', function (done) {
      var app = express()

      app.put('/items/:id', express.ifMatch({
        etag: function (req, cb) {
          cb(new Error('store down'))
        }
      }), function (req, res) {
        res.status(200).send('updated')
      })

      request(app)
        .put('/items/1')
        .set('If-Match', '*')
        .expect(500, done)
    })

    it('should accept a synchronously returned tag', function (done) {
      var app = express()

      app.put('/items/:id', express.ifMatch({
        requireHeader: true,
        etag: function (req) {
          return CURRENT_TAG
        }
      }), function (req, res) {
        assert.strictEqual(req.currentEtag, CURRENT_TAG)
        res.status(200).send('updated')
      })

      request(app)
        .put('/items/1')
        .set('If-Match', CURRENT_TAG)
        .expect(200, 'updated', done)
    })
  })

  describe('factory arguments', function () {
    it('should require an etag function', function () {
      assert.throws(function () { express.ifMatch() }, /etag must be a function/)
      assert.throws(function () { express.ifMatch({}) }, /etag must be a function/)
    })
  })
})

function createApp(options) {
  var app = express()
  app.locals.handlerCalls = 0

  app.put('/items/:id', express.ifMatch({
    etag: function (req) {
      var value = options.current
      if (value instanceof Error) {
        return Promise.reject(value)
      }
      return Promise.resolve(value)
    },
    requireHeader: options.requireHeader === true
  }), function (req, res) {
    app.locals.handlerCalls += 1
    if (typeof options.onPass === 'function') {
      options.onPass(req)
    }
    res.status(200).send('updated')
  })

  return app
}
