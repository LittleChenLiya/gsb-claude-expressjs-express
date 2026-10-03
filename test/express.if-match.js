'use strict'

var assert = require('node:assert')
var express = require('..')
var request = require('supertest')

describe('express.ifMatch()', function () {
  // counts how many times the downstream handler ran
  function makeApp(getEtag, options) {
    var app = express()
    var count = 0
    app.use(express.ifMatch(Object.assign({ getEtag: getEtag }, options)))
    app.all('/', function (req, res) {
      count++
      res.status(200).end()
    })
    return { app: app, getCount: function () { return count } }
  }

  function etagOf(tag) {
    return function (req, cb) { cb(null, tag) }
  }

  it('matches a strong entity tag', function (done) {
    var ctx = makeApp(etagOf('"abc"'))
    request(ctx.app)
      .get('/')
      .set('If-Match', '"abc"')
      .expect(200, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 1)
        done()
      })
  })

  it('matches when the current tag contains a comma', function (done) {
    var ctx = makeApp(etagOf('"a,b"'))
    request(ctx.app)
      .get('/')
      .set('If-Match', '"a,b"')
      .expect(200, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 1)
        done()
      })
  })

  it('matches one of several quoted tags, commas inside tags are literal', function (done) {
    var ctx = makeApp(etagOf('"b,c"'))
    request(ctx.app)
      .get('/')
      .set('If-Match', '"a", "b,c", "d"')
      .expect(200, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 1)
        done()
      })
  })

  it('does not match a weak header tag even with the same opaque tag', function (done) {
    var ctx = makeApp(etagOf('"abc"'))
    request(ctx.app)
      .get('/')
      .set('If-Match', 'W/"abc"')
      .expect(412, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 0)
        done()
      })
  })

  it('does not match when the current entity tag is weak', function (done) {
    var ctx = makeApp(etagOf('W/"abc"'))
    request(ctx.app)
      .get('/')
      .set('If-Match', '"abc"')
      .expect(412, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 0)
        done()
      })
  })

  it('ignores weak tags and still matches a strong tag in the list', function (done) {
    var ctx = makeApp(etagOf('"abc"'))
    request(ctx.app)
      .get('/')
      .set('If-Match', 'W/"abc", "abc"')
      .expect(200, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 1)
        done()
      })
  })

  it('does not match a different strong tag', function (done) {
    var ctx = makeApp(etagOf('"abc"'))
    request(ctx.app)
      .get('/')
      .set('If-Match', '"def"')
      .expect(412, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 0)
        done()
      })
  })

  it('wildcard * matches when a strong current tag exists', function (done) {
    var ctx = makeApp(etagOf('"abc"'))
    request(ctx.app)
      .get('/')
      .set('If-Match', '*')
      .expect(200, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 1)
        done()
      })
  })

  it('wildcard * does not match when the resource has no current tag', function (done) {
    var ctx = makeApp(etagOf(null))
    request(ctx.app)
      .get('/')
      .set('If-Match', '*')
      .expect(412, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 0)
        done()
      })
  })

  it('wildcard * does not match when the current tag is weak', function (done) {
    var ctx = makeApp(etagOf('W/"abc"'))
    request(ctx.app)
      .get('/')
      .set('If-Match', '*')
      .expect(412, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 0)
        done()
      })
  })

  it('proceeds when the header is missing by default', function (done) {
    var ctx = makeApp(etagOf('"abc"'))
    request(ctx.app)
      .get('/')
      .expect(200, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 1)
        done()
      })
  })

  it('returns 428 when the header is missing and requireHeader is true', function (done) {
    var ctx = makeApp(etagOf('"abc"'), { requireHeader: true })
    request(ctx.app)
      .get('/')
      .expect(428, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 0)
        done()
      })
  })

  it('returns 400 for an unclosed quoted tag', function (done) {
    var ctx = makeApp(etagOf('"abc"'))
    request(ctx.app)
      .get('/')
      .set('If-Match', '"abc')
      .expect(400, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 0)
        done()
      })
  })

  it('returns 400 for a lowercase weak marker', function (done) {
    var ctx = makeApp(etagOf('"abc"'))
    request(ctx.app)
      .get('/')
      .set('If-Match', 'w/"abc"')
      .expect(400, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 0)
        done()
      })
  })

  it('returns 400 for a tag without a quote', function (done) {
    var ctx = makeApp(etagOf('"abc"'))
    request(ctx.app)
      .get('/')
      .set('If-Match', 'abc')
      .expect(400, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 0)
        done()
      })
  })

  it('returns 400 for an empty header', function (done) {
    var ctx = makeApp(etagOf('"abc"'))
    request(ctx.app)
      .get('/')
      .set('If-Match', '')
      .expect(400, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 0)
        done()
      })
  })

  it('propagates a getEtag callback error instead of treating it as a non-match', function (done) {
    var ctx = makeApp(function (req, cb) { cb(new Error('store unavailable')) })
    request(ctx.app)
      .get('/')
      .set('If-Match', '"abc"')
      .expect(500, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 0)
        done()
      })
  })

  it('propagates a getEtag synchronous throw instead of treating it as a non-match', function (done) {
    var ctx = makeApp(function () { throw new Error('boom') })
    request(ctx.app)
      .get('/')
      .set('If-Match', '"abc"')
      .expect(500, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 0)
        done()
      })
  })

  it('propagates a rejected getEtag promise instead of treating it as a non-match', function (done) {
    var ctx = makeApp(function () { return Promise.reject(new Error('nope')) })
    request(ctx.app)
      .get('/')
      .set('If-Match', '"abc"')
      .expect(500, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 0)
        done()
      })
  })

  it('queries the current etag at most once per request', function (done) {
    var calls = 0
    var ctx = makeApp(function (req, cb) {
      calls++
      cb(null, '"abc"')
    })
    request(ctx.app)
      .get('/')
      .set('If-Match', '"abc"')
      .expect(200, function (err) {
        if (err) return done(err)
        assert.strictEqual(calls, 1)
        done()
      })
  })

  it('supports a promise-returning getEtag', function (done) {
    var ctx = makeApp(function () { return Promise.resolve('"abc"') })
    request(ctx.app)
      .get('/')
      .set('If-Match', '"abc"')
      .expect(200, function (err) {
        if (err) return done(err)
        assert.strictEqual(ctx.getCount(), 1)
        done()
      })
  })

  it('throws when getEtag is not a function', function () {
    assert.throws(function () {
      express.ifMatch({})
    }, /requires a getEtag function/)
  })

  it('accepts a bare function as options', function (done) {
    var app = express()
    var count = 0
    app.use(express.ifMatch(function (req, cb) { cb(null, '"abc"') }))
    app.get('/', function (req, res) { count++; res.status(200).end() })
    request(app)
      .get('/')
      .set('If-Match', '"abc"')
      .expect(200, function (err) {
        if (err) return done(err)
        assert.strictEqual(count, 1)
        done()
      })
  })
})
