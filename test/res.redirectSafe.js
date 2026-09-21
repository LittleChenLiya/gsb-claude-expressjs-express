'use strict'

var assert = require('assert')
var express = require('..')
var request = require('supertest')

var BASE_ORIGIN = 'https://app.example.com'

var POLICY = {
  baseOrigin: BASE_ORIGIN,
  allowedOrigins: [
    'https://sso.example.net',
    'http://localhost:8080',
    'https://xn--bcher-kva.example'
  ]
}

describe('res', function () {
  describe('.redirectSafe(target, policy)', function () {
    describe('allowed targets', function () {
      var cases = [
        { name: 'same-site absolute path', path: '/login', target: '/dashboard', location: 'https://app.example.com/dashboard' },
        { name: 'relative subpath', path: '/account/profile', target: 'settings', location: 'https://app.example.com/account/settings' },
        { name: 'relative parent path', path: '/account/profile', target: '../help', location: 'https://app.example.com/help' },
        { name: 'query string and fragment', path: '/login', target: '/search?q=a%20b&x=1#top', location: 'https://app.example.com/search?q=a%20b&x=1#top' },
        { name: 'relative path with query and fragment', path: '/account/profile', target: 'list?page=2#row3', location: 'https://app.example.com/account/list?page=2#row3' },
        { name: 'default https port on target', path: '/', target: 'https://app.example.com:443/dash', location: 'https://app.example.com/dash' },
        { name: 'allowed external origin', path: '/', target: 'https://sso.example.net/callback?code=1', location: 'https://sso.example.net/callback?code=1' },
        { name: 'allowed non-default port', path: '/', target: 'http://localhost:8080/cb', location: 'http://localhost:8080/cb' },
        { name: 'internationalized domain in allowed set', path: '/', target: 'https://bücher.example/lesen', location: 'https://xn--bcher-kva.example/lesen' }
      ]

      cases.forEach(function (tc) {
        it('should allow ' + tc.name, function (done) {
          var app = express()

          app.use(function (req, res) {
            res.redirectSafe(tc.target, POLICY)
          })

          request(app)
            .get(tc.path)
            .expect('location', tc.location)
            .expect(302, done)
        })
      })

      it('should support a custom status', function (done) {
        var app = express()

        app.use(function (req, res) {
          res.redirectSafe(303, '/dashboard', POLICY)
        })

        request(app)
          .get('/')
          .expect('location', 'https://app.example.com/dashboard')
          .expect(303, done)
      })

      it('should send the html body like res.redirect', function (done) {
        var app = express()

        app.use(function (req, res) {
          res.redirectSafe('/dashboard', POLICY)
        })

        request(app)
          .get('/')
          .set('Accept', 'text/html')
          .expect(302, '<!DOCTYPE html><head><title>Found</title></head><body><p>Found. Redirecting to https://app.example.com/dashboard</p></body>', done)
      })

      it('should send the text body like res.redirect', function (done) {
        var app = express()

        app.use(function (req, res) {
          res.redirectSafe('/dashboard', POLICY)
        })

        request(app)
          .get('/')
          .set('Accept', 'text/plain')
          .expect(302, 'Found. Redirecting to https://app.example.com/dashboard', done)
      })

      it('should not send a body for HEAD requests', function (done) {
        var app = express()

        app.use(function (req, res) {
          res.redirectSafe('/dashboard', POLICY)
        })

        request(app)
          .head('/')
          .expect('location', 'https://app.example.com/dashboard')
          .expect(302)
          .expect(function (res) {
            assert.ok(!res.text)
            assert.deepStrictEqual(res.body, {})
          })
          .end(done)
      })
    })

    describe('rejected targets', function () {
      var cases = [
        { name: 'origin suffix confusion', target: 'https://app.example.com.evil.example/' },
        { name: 'userinfo', target: 'https://user@app.example.com/dashboard' },
        { name: 'userinfo host spoofing', target: 'https://app.example.com@evil.example/' },
        { name: 'network-path reference', target: '//evil.example/' },
        { name: 'backslash', target: 'https:\\evil.example' },
        { name: 'control characters', target: '/\r\nLocation: https://evil.example' },
        { name: 'percent-encoded CR/LF', target: '/%0d%0aLocation:%20https://evil.example' },
        { name: 'double-encoded CR/LF', target: '/%250d%250aLocation:%2520https://evil.example' },
        { name: 'non-default port on base origin', target: 'https://app.example.com:8443/' },
        { name: 'unlisted port on allowed host', target: 'http://localhost:8081/' },
        { name: 'unlisted origin', target: 'https://evil.example/' },
        { name: 'internationalized domain outside allowed set', target: 'https://bücher.example.evil.example/' },
        { name: 'javascript: scheme', target: 'javascript:alert(1)' },
        { name: 'data: scheme', target: 'data:text/html,<script>alert(1)</script>' },
        { name: 'empty target', target: '' }
      ]

      cases.forEach(function (tc) {
        it('should reject ' + tc.name, function (done) {
          var app = express()

          app.use(function (req, res) {
            assert.throws(function () {
              res.redirectSafe(tc.target, POLICY)
            }, function (err) {
              assert.strictEqual(err.code, 'ERR_REDIRECT_TARGET_REJECTED')
              return true
            })
            assert.strictEqual(res.headersSent, false)
            res.status(200).end('rejected')
          })

          request(app)
            .get('/')
            .expect(200, 'rejected', done)
        })
      })
    })

    describe('invalid policies', function () {
      var cases = [
        { name: 'missing policy', policy: undefined },
        { name: 'null policy', policy: null },
        { name: 'array policy', policy: [BASE_ORIGIN] },
        { name: 'missing baseOrigin', policy: { allowedOrigins: [] } },
        { name: 'non-http baseOrigin', policy: { baseOrigin: 'ftp://app.example.com' } },
        { name: 'baseOrigin with path', policy: { baseOrigin: 'https://app.example.com/app' } },
        { name: 'baseOrigin with userinfo', policy: { baseOrigin: 'https://user@app.example.com' } },
        { name: 'allowedOrigins not an array', policy: { baseOrigin: BASE_ORIGIN, allowedOrigins: 'https://x.example' } },
        { name: 'allowedOrigins entry not an origin', policy: { baseOrigin: BASE_ORIGIN, allowedOrigins: ['not a url'] } }
      ]

      cases.forEach(function (tc) {
        it('should throw on ' + tc.name, function (done) {
          var app = express()

          app.use(function (req, res) {
            assert.throws(function () {
              res.redirectSafe('/dashboard', tc.policy)
            }, function (err) {
              assert.strictEqual(err.code, 'ERR_REDIRECT_POLICY_INVALID')
              return true
            })
            assert.strictEqual(res.headersSent, false)
            res.status(200).end('invalid policy')
          })

          request(app)
            .get('/')
            .expect(200, 'invalid policy', done)
        })
      })
    })

    describe('with "trust proxy" enabled', function () {
      it('should not widen trust from Host or X-Forwarded-Host', function (done) {
        var app = express()

        app.enable('trust proxy')

        app.use(function (req, res) {
          res.redirectSafe('/dashboard', POLICY)
        })

        request(app)
          .get('/')
          .set('Host', 'evil.example')
          .set('X-Forwarded-Host', 'evil.example')
          .expect('location', 'https://app.example.com/dashboard')
          .expect(302, done)
      })

      it('should still reject a target matching the forged Host', function (done) {
        var app = express()

        app.enable('trust proxy')

        app.use(function (req, res) {
          assert.throws(function () {
            res.redirectSafe('http://evil.example/', POLICY)
          }, function (err) {
            assert.strictEqual(err.code, 'ERR_REDIRECT_TARGET_REJECTED')
            return true
          })
          assert.strictEqual(res.headersSent, false)
          res.status(200).end('rejected')
        })

        request(app)
          .get('/')
          .set('Host', 'evil.example')
          .set('X-Forwarded-Host', 'evil.example')
          .expect(200, 'rejected', done)
      })
    })
  })
})

