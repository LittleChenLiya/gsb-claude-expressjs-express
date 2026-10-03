'use strict'

/**
 * Strict query parsing demo.
 *
 * The `express.strictQuery` middleware parses the raw query component of
 * the original URL into `req.strictQuery` without touching `req.query`.
 * It rejects the request (400) before the handler runs whenever:
 *   - the same key appears twice after percent-decoding ("a" and "%61")
 *   - a percent escape is malformed (a lone or half "%" sequence)
 *   - percent-decoded bytes are not valid UTF-8
 *
 * Bracket keys such as `a[b]` stay literal, `+` means space per the form
 * rule, `__proto__` is plain data and an absent query yields an empty
 * read-only snapshot.
 *
 * Run the server:
 *
 *     node examples/strict-query
 *     curl "http://localhost:3000/?a=1&%61=2"
 *
 * Run the built-in httptest-style self-check (starts the app on an
 * ephemeral port, makes real HTTP requests, prints the results and
 * exits):
 *
 *     node examples/strict-query --selftest
 */

var express = require('../../')

var app = module.exports = express()

app.use(express.strictQuery())

app.get('/', function (req, res) {
  res.json({
    query: req.query,
    strictQuery: req.strictQuery
  })
})

// surface strict-parse failures (and only those) as concise JSON so the
// error code and raw position are easy to inspect
app.use(function (err, req, res, next) {
  if (err.status !== 400) return next(err)
  res.status(400).json({
    error: err.message,
    code: err.code,
    position: err.position
  })
})

/* istanbul ignore next */
if (!module.parent && process.argv[2] !== '--selftest') {
  app.listen(3000)
  console.log('Express started on port 3000')
}

/* istanbul ignore next */
if (require.main === module && process.argv[2] === '--selftest') {
  runSelfTest()
}

/* istanbul ignore next */
function runSelfTest () {
  var http = require('node:http')

  var cases = [
    {
      title: 'ordinary query',
      path: '/?a=1&b=two',
      expectStatus: 200
    },
    {
      title: 'duplicate key by decoded identity (a vs %61)',
      path: '/?a=1&%61=2',
      expectStatus: 400,
      expectBody: /Duplicate query parameter \\"a\\" at positions 0 and 4/
    },
    {
      title: 'literal bracket key a%5Bb%5D',
      path: '/?a%5Bb%5D=1',
      expectStatus: 200,
      expectBody: /"a\[b\]":"1"/
    },
    {
      title: '__proto__ stays ordinary data',
      path: '/?__proto__=evil',
      expectStatus: 200,
      expectBody: /"__proto__":"evil"/
    },
    {
      title: 'plus sign decoded as a space (form rule)',
      path: '/?q=hello+world',
      expectStatus: 200,
      expectBody: /"q":"hello world"/
    },
    {
      title: 'lone percent reported at its raw offset',
      path: '/?bad=100%25',
      expectStatus: 200
    },
    {
      title: 'malformed percent escape',
      path: '/?bad=100%2',
      expectStatus: 400,
      expectBody: /Malformed percent-encoding at position 7/
    },
    {
      title: 'bad UTF-8 reported at its raw offset',
      path: '/?bad=%E2%82',
      expectStatus: 400,
      expectBody: /Invalid UTF-8 in query string at position 4/
    },
    {
      title: 'no query returns an empty snapshot',
      path: '/',
      expectStatus: 200,
      expectBody: /"strictQuery":\{\}/
    }
  ]

  var server = app.listen(0, '127.0.0.1', function () {
    var port = server.address().port
    var failures = 0
    var pending = cases.length

    console.log('strict-query self-test on http://127.0.0.1:' + port + '\n')

    cases.forEach(function (testCase) {
      http.get({
        hostname: '127.0.0.1',
        port: port,
        path: testCase.path
      }, function (res) {
        var chunks = ''

        res.setEncoding('utf8')
        res.on('data', function (chunk) { chunks += chunk })
        res.on('end', function () {
          var ok = res.statusCode === testCase.expectStatus
            && (testCase.expectBody === undefined
              || testCase.expectBody.test(chunks))

          if (ok) {
            console.log('PASS  ' + res.statusCode + '  ' + testCase.title)
          } else {
            failures++
            console.log('FAIL  expected ' + testCase.expectStatus
              + ' got ' + res.statusCode + '  ' + testCase.title)
            console.log('      body: ' + chunks)
          }

          pending--
          if (pending === 0) {
            server.close(function () {
              console.log(failures === 0
                ? '\nall ' + cases.length + ' checks passed'
                : '\n' + failures + ' check(s) failed')
              process.exitCode = failures === 0 ? 0 : 1
            })
          }
        })
      })
    })
  })
}

