'use strict'

var assert = require('node:assert')
var express = require('..')
var request = require('supertest')

var strictQuery = require('../lib/middleware/strictQuery')
var parse = strictQuery.parse

function createApp(options) {
  var app = express()

  app.use(strictQuery(options))

  app.get('/', function (req, res) {
    res.json({
      query: req.query,
      strict: req.strictQuery
    })
  })

  return app
}

describe('express.strictQuery()', function () {
  describe('parser', function () {
    it('should return an empty frozen null-prototype snapshot without a query', function () {
      var result = parse('')

      assert.deepStrictEqual(Object.keys(result), [])
      assert.strictEqual(Object.getPrototypeOf(result), null)
      assert.ok(Object.isFrozen(result))
    })

    it('should share the empty snapshot between parses', function () {
      assert.strictEqual(parse(''), parse(null))
      assert.strictEqual(parse(''), parse(undefined))
    })

    it('should parse simple key/value pairs', function () {
      var result = parse('a=1&b=2')

      assert.strictEqual(result.a, '1')
      assert.strictEqual(result.b, '2')
    })

    it('should treat value-less keys as empty strings', function () {
      var result = parse('a&b=')

      assert.strictEqual(result.a, '')
      assert.strictEqual(result.b, '')
    })

    it('should decode percent-encoded UTF-8', function () {
      var result = parse('name=%E4%B8%AD%E6%96%87&x=%F0%9F%98%80')

      assert.strictEqual(result.name, '中文')
      assert.strictEqual(result.x, '😀')
    })

    it('should accept literal UTF-8 characters', function () {
      assert.strictEqual(parse('name=中文').name, '中文')
    })

    it('should decode "+" as a space following the form rule', function () {
      var result = parse('a+b=c+d')

      assert.strictEqual(result['a b'], 'c d')
    })

    it('should keep "+" literal with plus: "keep"', function () {
      var result = parse('a+b=c+d', { plus: 'keep' })

      assert.strictEqual(result['a+b'], 'c+d')
    })

    it('should store bracket keys literally without nesting', function () {
      var result = parse('a%5Bb%5D=1&a[]=2')

      assert.deepStrictEqual(Object.keys(result), ['a[b]', 'a[]'])
      assert.strictEqual(result['a[b]'], '1')
      assert.strictEqual(result['a[]'], '2')
    })

    it('should report duplicate decoded keys with both raw positions', function () {
      try {
        parse('a=1&%61=2')
        throw new Error('should have thrown')
      } catch (err) {
        assert.strictEqual(err.code, 'DUPLICATE_QUERY_KEY')
        assert.strictEqual(err.position, 0)
        assert.ok(/at positions 0 and 4/.test(err.message))
      }
    })

    it('should reject literal duplicate keys', function () {
      assert.throws(function () { parse('x=1&x=2') }, function (err) {
        return err.code === 'DUPLICATE_QUERY_KEY'
          && err.position === 0
          && /0 and 4/.test(err.message)
      })
    })

    it('should treat "__proto__" as ordinary data', function () {
      var result = parse('__proto__=evil&constructor=bad')

      assert.strictEqual(Object.getPrototypeOf(result), null)
      var descriptor = Object.getOwnPropertyDescriptor(result, '__proto__')
      assert.strictEqual(descriptor.value, 'evil')
      assert.strictEqual(descriptor.writable, false)
      assert.strictEqual(result.constructor, 'bad')

      var plain = {}
      assert.strictEqual(plain.polluted, undefined)
    })

    it('should return a frozen snapshot that cannot be modified', function () {
      var result = parse('a=1')

      assert.ok(Object.isFrozen(result))
      assert.throws(function () {
        'use strict'
        result.a = 2
      }, TypeError)
    })

    it('should report a lone percent at its raw offset', function () {
      try {
        parse('x=1&bad=%2')
        throw new Error('should have thrown')
      } catch (err) {
        assert.strictEqual(err.code, 'MALFORMED_PERCENT_ENCODING')
        assert.strictEqual(err.position, 8)
      }
    })

    it('should report a trailing percent at its raw offset', function () {
      assert.throws(function () { parse('a=100%') }, function (err) {
        return err.code === 'MALFORMED_PERCENT_ENCODING'
          && err.position === 5
      })
    })

    it('should report non-hex percent escapes distinctly from bad UTF-8', function () {
      assert.throws(function () { parse('%zz') }, function (err) {
        return err.code === 'MALFORMED_PERCENT_ENCODING'
          && err.position === 0
      })
    })

    it('should report bad UTF-8 at the lead byte raw offset', function () {
      assert.throws(function () { parse('x=1&bad=%E2%82') }, function (err) {
        return err.code === 'INVALID_UTF8' && err.position === 8
      })
    })

    it('should report an invalid continuation byte at its own raw offset', function () {
      // "%E2%41" - the lead byte starts a sequence but 0x41 is not a
      // continuation byte, so the sequence is rejected at its lead offset
      assert.throws(function () { parse('%E2%41') }, function (err) {
        return err.code === 'INVALID_UTF8' && err.position === 0
      })
      assert.throws(function () { parse('ab%E2%41') }, function (err) {
        return err.code === 'INVALID_UTF8' && err.position === 2
      })
      // 0xFF is never a valid UTF-8 lead byte
      assert.throws(function () { parse('%FF') }, function (err) {
        return err.code === 'INVALID_UTF8' && err.position === 0
      })
      // a truncated sequence at end of input reports at the lead byte
      assert.throws(function () { parse('%E2%82') }, function (err) {
        return err.code === 'INVALID_UTF8' && err.position === 0
      })
    })

    it('should report positions relative to the raw query, not post-decode', function () {
      // "%C3%A9" decodes to a single character; the bad sequence starts at
      // raw offset 11 which must not collapse to the post-decode offset 7
      assert.throws(function () { parse('%C3%A9&bad=%E2%82') }, function (err) {
        return err.code === 'INVALID_UTF8' && err.position === 11
      })
    })

    it('should reject malformed escapes before duplicate keys', function () {
      assert.throws(function () { parse('a=1&a=%2') }, function (err) {
        return err.code === 'MALFORMED_PERCENT_ENCODING'
      })
    })
  })

  describe('middleware', function () {
    it('should not change req.query default parsing when not installed', function (done) {
      var app = express()
      app.get('/', function (req, res) {
        res.json(req.query)
      })

      request(app)
        .get('/?a=1&a=2&user[name]=tj')
        .expect(200)
        .expect(function (res) {
          // the built-in "simple" parser aggregates duplicate keys and
          // never builds nested objects
          assert.deepStrictEqual(res.body.a, ['1', '2'])
          assert.strictEqual(res.body['user[name]'], 'tj')
        })
        .end(done)
    })

    it('should leave the default req.query parser untouched', function (done) {
      request(createApp())
        .get('/?user[name]=tj')
        .expect(200)
        .expect(function (res) {
          // default simple parser keeps literal bracket keys
          assert.strictEqual(res.body.query['user[name]'], 'tj')
          assert.deepStrictEqual(res.body.strict, { 'user[name]': 'tj' })
        })
        .end(done)
    })

    it('should expose the strict result on a separate property', function (done) {
      request(createApp())
        .get('/?a=1')
        .expect(200)
        .expect(function (res) {
          assert.deepStrictEqual(res.body.strict, { a: '1' })
        })
        .end(done)
    })

    it('should return an empty object without a query string', function (done) {
      request(createApp())
        .get('/')
        .expect(200)
        .expect(function (res) {
          assert.deepStrictEqual(res.body.strict, {})
        })
        .end(done)
    })

    it('should not call the handler on a duplicate key', function (done) {
      var called = false
      var app = express()
      app.use(strictQuery())
      app.get('/', function (req, res) {
        called = true
        res.end()
      })

      request(app)
        .get('/?a=1&%61=2')
        .expect(400)
        .expect(function () { assert.strictEqual(called, false) })
        .end(done)
    })

    it('should not call the handler on malformed encoding', function (done) {
      var called = false
      var app = express()
      app.use(strictQuery())
      app.get('/', function (req, res) {
        called = true
        res.end()
      })

      request(app)
        .get('/?bad=%2')
        .expect(400)
        .expect(function (res) {
          assert.strictEqual(called, false)
          assert.ok(/Malformed percent-encoding at position 4/.test(res.text))
        })
        .end(done)
    })

    it('should not call the handler on invalid UTF-8', function (done) {
      var called = false
      var app = express()
      app.use(strictQuery())
      app.get('/', function (req, res) {
        called = true
        res.end()
      })

      request(app)
        .get('/?bad=%E2%82')
        .expect(400)
        .expect(function (res) {
          assert.strictEqual(called, false)
          assert.ok(/Invalid UTF-8 in query string at position 4/.test(res.text))
        })
        .end(done)
    })

    it('should keep "__proto__" as data through the stack', function (done) {
      var expected = {}
      Object.defineProperty(expected, '__proto__', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: 'evil'
      })

      request(createApp())
        .get('/?__proto__=evil')
        .expect(200)
        .expect(function (res) {
          assert.deepStrictEqual(res.body.strict, expected)
          assert.strictEqual({}.polluted, undefined)
        })
        .end(done)
    })

    it('should decode brackets literally', function (done) {
      request(createApp())
        .get('/?a%5Bb%5D=1')
        .expect(200)
        .expect(function (res) {
          assert.deepStrictEqual(res.body.strict, { 'a[b]': '1' })
        })
        .end(done)
    })

    it('should isolate parsed snapshots across requests', function (done) {
      var app = createApp()

      request(app)
        .get('/?a=1')
        .expect(200)
        .end(function (err) {
          if (err) return done(err)

          request(app)
            .get('/?b=2')
            .expect(200)
            .expect(function (res) {
              assert.deepStrictEqual(res.body.strict, { b: '2' })
              assert.strictEqual(res.body.strict.a, undefined)
            })
            .end(done)
        })
    })

    it('should share the empty snapshot across empty requests', function (done) {
      var app = express()
      app.use(strictQuery())
      var snapshots = []
      app.get('/', function (req, res) {
        snapshots.push(req.strictQuery)
        res.end(String(snapshots.length))
      })

      request(app)
        .get('/')
        .expect(200, '1')
        .end(function (err) {
          if (err) return done(err)

          request(app)
            .get('/')
            .expect(200, '2')
            .end(function (err) {
              if (err) return done(err)
              assert.strictEqual(snapshots[0], snapshots[1])
              done()
            })
        })
    })

    it('should support a custom result property', function (done) {
      var app = express()
      app.use(strictQuery({ property: 'strictParams' }))
      app.get('/', function (req, res) {
        res.json(req.strictParams)
      })

      request(app)
        .get('/?a=1')
        .expect(200, { a: '1' }, done)
    })

    it('should reject invalid options at setup time', function () {
      assert.throws(function () { strictQuery({ property: '' }) })
      assert.throws(function () { strictQuery({ plus: 'nope' }) })
    })
  })
})

