'use strict'

var assert = require('assert')
var express = require('..')
var request = require('supertest')

var BASE = 'https://app.example.com'
var REJECTED_CODE = 'ERR_REDIRECT_TARGET_REJECTED'

function createApp (target, policy, options) {
  options = options || {}

  var app = express()

  if (options.trustProxy) {
    app.set('trust proxy', true)
  }

  app.use(function (req, res) {
    try {
      if (options.status) {
        res.redirectSafe(options.status, target, policy)
      } else {
        res.redirectSafe(target, policy)
      }
    } catch (err) {
      res.status(err instanceof TypeError ? 500 : 400).json({
        code: err.code || null,
        name: err.name,
        headersSent: res.headersSent
      })
    }
  })

  return app
}

describe('res', function () {
  describe('.redirectSafe(target, policy)', function () {
    var cases = [
      {
        name: 'should redirect a same-origin absolute path',
        target: '/dashboard',
        policy: { baseOrigin: BASE },
        path: '/login',
        location: BASE + '/dashboard'
      },
      {
        name: 'should resolve a relative subpath against originalUrl',
        target: '../login',
        policy: { baseOrigin: BASE },
        path: '/blog/post/1',
        location: BASE + '/blog/login'
      },
      {
        name: 'should resolve a sibling relative path against originalUrl',
        target: 'edit',
        policy: { baseOrigin: BASE },
        path: '/blog/post/1',
        location: BASE + '/blog/post/edit'
      },
      {
        name: 'should preserve query string and fragment',
        target: '/search?q=redirect&page=2#results',
        policy: { baseOrigin: BASE },
        path: '/login',
        location: BASE + '/search?q=redirect&page=2#results'
      },
      {
        name: 'should ignore the query string of the current request when resolving',
        target: 'next',
        policy: { baseOrigin: BASE },
        path: '/blog/post/1?returnTo=https://evil.example',
        location: BASE + '/blog/post/next'
      },
      {
        name: 'should allow an explicitly listed external origin',
        target: 'https://docs.example.com/page',
        policy: { baseOrigin: BASE, allowedOrigins: ['https://docs.example.com'] },
        path: '/login',
        location: 'https://docs.example.com/page'
      },
      {
        name: 'should treat the default https port as equal to no port',
        target: 'https://app.example.com:443/ok',
        policy: { baseOrigin: BASE },
        path: '/login',
        location: BASE + '/ok'
      },
      {
        name: 'should treat the default http port as equal to no port',
        target: 'http://app.example.com:80/ok',
        policy: { baseOrigin: 'http://app.example.com' },
        path: '/login',
        location: 'http://app.example.com/ok'
      },
      {
        name: 'should allow a non-default port only when listed',
        target: 'https://app.example.com:8443/internal',
        policy: { baseOrigin: BASE, allowedOrigins: ['https://app.example.com:8443'] },
        path: '/login',
        location: 'https://app.example.com:8443/internal'
      },
      {
        name: 'should match internationalized domains in ASCII form',
        target: 'https://xn--bcher-kva.example/buch',
        policy: { baseOrigin: 'https://bücher.example' },
        path: '/login',
        location: 'https://xn--bcher-kva.example/buch'
      },
      {
        name: 'should normalize unicode targets to punycode before comparing',
        target: 'https://bücher.example/buch',
        policy: { baseOrigin: 'https://xn--bcher-kva.example' },
        path: '/login',
        location: 'https://xn--bcher-kva.example/buch'
      },
      {
        name: 'should reject a non-default port that is not listed',
        target: 'https://app.example.com:8443/internal',
        policy: { baseOrigin: BASE },
        path: '/login',
        reject: true
      },
      {
        name: 'should reject a look-alike suffix domain',
        target: 'https://app.example.com.evil.example/x',
        policy: { baseOrigin: BASE },
        path: '/login',
        reject: true
      },
      {
        name: 'should reject userinfo in the authority',
        target: 'https://user@app.example.com/x',
        policy: { baseOrigin: BASE },
        path: '/login',
        reject: true
      },
      {
        name: 'should reject userinfo with password in the authority',
        target: 'https://user:secret@app.example.com/x',
        policy: { baseOrigin: BASE },
        path: '/login',
        reject: true
      },
      {
        name: 'should reject network-path references',
        target: '//evil.example/x',
        policy: { baseOrigin: BASE },
        path: '/login',
        reject: true
      },
      {
        name: 'should reject backslashes',
        target: 'https://app.example.com\\\\@evil.example/',
        policy: { baseOrigin: BASE },
        path: '/login',
        reject: true
      },
      {
        name: 'should reject backslashes in paths',
        target: '/foo\\\\bar',
        policy: { baseOrigin: BASE },
        path: '/login',
        reject: true
      },
      {
        name: 'should reject raw control characters',
        target: '/foo\u0009bar',
        policy: { baseOrigin: BASE },
        path: '/login',
        reject: true
      },
      {
        name: 'should reject percent-encoded CR/LF',
        target: '/login%0d%0aLocation:%20https://evil.example',
        policy: { baseOrigin: BASE },
        path: '/login',
        reject: true
      },
      {
        name: 'should reject double-encoded CR/LF',
        target: '/login%250d%250aLocation:%20https://evil.example',
        policy: { baseOrigin: BASE },
        path: '/login',
        reject: true
      },
      {
        name: 'should reject percent-encoded backslashes',
        target: '/%5c%5cevil.example',
        policy: { baseOrigin: BASE },
        path: '/login',
        reject: true
      },
      {
        name: 'should reject non-http(s) protocols',
        target: 'javascript:alert(1)',
        policy: { baseOrigin: BASE },
        path: '/login',
        reject: true
      },
      {
        name: 'should reject other protocols on the same host',
        target: 'ftp://app.example.com/x',
        policy: { baseOrigin: BASE },
        path: '/login',
        reject: true
      },
      {
        name: 'should reject a different protocol on the base host',
        target: 'http://app.example.com/x',
        policy: { baseOrigin: BASE },
        path: '/login',
        reject: true
      },
      {
        name: 'should reject unlisted external origins',
        target: 'https://evil.example/x',
        policy: { baseOrigin: BASE, allowedOrigins: ['https://docs.example.com'] },
        path: '/login',
        reject: true
      }
    ]

    cases.forEach(function (testCase) {
      it(testCase.name, function (done) {
        var app = createApp(testCase.target, testCase.policy)
        var test = request(app).get(testCase.path)

        if (testCase.reject) {
          test
            .expect(400)
            .expect(function (res) {
              assert.strictEqual(res.headers.location, undefined)
              assert.strictEqual(res.body.code, REJECTED_CODE)
              assert.strictEqual(res.body.headersSent, false)
            })
            .end(done)
        } else {
          test
            .expect('location', testCase.location)
            .expect(302, done)
        }
      })
    })

    it('should support an explicit redirect status', function (done) {
      var app = createApp('/dashboard', { baseOrigin: BASE }, { status: 301 })

      request(app)
        .get('/login')
        .expect('location', BASE + '/dashboard')
        .expect(301, done)
    })

    it('should send no body for HEAD requests', function (done) {
      var app = createApp('/dashboard', { baseOrigin: BASE })

      request(app)
        .head('/login')
        .expect('location', BASE + '/dashboard')
        .expect(302)
        .expect(function (res) {
          assert.ok(!res.text)
        })
        .end(done)
    })

    it('should include the redirect body for GET requests', function (done) {
      var app = createApp('/dashboard', { baseOrigin: BASE })

      request(app)
        .get('/login')
        .expect('location', BASE + '/dashboard')
        .expect(302, 'Found. Redirecting to ' + BASE + '/dashboard', done)
    })

    it('should not trust Host or X-Forwarded-Host with trust proxy enabled', function (done) {
      var app = createApp('/dashboard', { baseOrigin: BASE }, { trustProxy: true })

      request(app)
        .get('/login')
        .set('Host', 'evil.example')
        .set('X-Forwarded-Host', 'evil.example')
        .set('X-Forwarded-Proto', 'https')
        .expect('location', BASE + '/dashboard')
        .expect(302, done)
    })

    it('should not widen the allowed set from forged Host-like headers', function (done) {
      var app = createApp('https://evil.example/x', { baseOrigin: BASE }, { trustProxy: true })

      request(app)
        .get('/login')
        .set('Host', 'evil.example')
        .set('X-Forwarded-Host', 'evil.example')
        .expect(400)
        .expect(function (res) {
          assert.strictEqual(res.headers.location, undefined)
          assert.strictEqual(res.body.code, REJECTED_CODE)
          assert.strictEqual(res.body.headersSent, false)
        })
        .end(done)
    })

    describe('policy misconfiguration', function () {
      var badPolicies = [
        { name: 'missing policy', policy: undefined },
        { name: 'missing baseOrigin', policy: {} },
        { name: 'empty baseOrigin', policy: { baseOrigin: '' } },
        { name: 'baseOrigin with a path', policy: { baseOrigin: BASE + '/app' } },
        { name: 'baseOrigin with userinfo', policy: { baseOrigin: 'https://user@app.example.com' } },
        { name: 'baseOrigin with a non-http protocol', policy: { baseOrigin: 'ftp://app.example.com' } },
        { name: 'allowedOrigins not an array', policy: { baseOrigin: BASE, allowedOrigins: 'https://docs.example.com' } },
        { name: 'allowedOrigins with an invalid origin', policy: { baseOrigin: BASE, allowedOrigins: ['not a url'] } }
      ]

      badPolicies.forEach(function (testCase) {
        it('should throw a TypeError before responding: ' + testCase.name, function (done) {
          var app = createApp('/dashboard', testCase.policy)

          request(app)
            .get('/login')
            .expect(500)
            .expect(function (res) {
              assert.strictEqual(res.headers.location, undefined)
              assert.strictEqual(res.body.name, 'TypeError')
              assert.strictEqual(res.body.headersSent, false)
            })
            .end(done)
        })
      })
    })
  })
})
