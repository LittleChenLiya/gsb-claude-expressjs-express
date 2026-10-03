/*!
 * httptest-style local demo for the strict query middleware.
 *
 * Starts a real Express server on an ephemeral port (like Go's
 * net/http/httptest), fires a handful of requests at it, and prints
 * the responses. Run it with:
 *
 *   node examples/strict-query
 */

'use strict';

var express = require('../../');
var http = require('node:http');

var app = express();

app.use(express.strictQuery());

app.get('/', function (req, res) {
  res.send({
    strictQuery: req.strictQuery,
    frozen: Object.isFrozen(req.strictQuery),
    protoIsNull: Object.getPrototypeOf(req.strictQuery) === null
  });
});

// error handler: turn strict query errors into readable JSON
app.use(function (err, req, res, next) {
  res.status(err.status || 500).send({
    error: err.message,
    code: err.code,
    position: err.position,
    positions: err.positions
  });
});

var server = app.listen(0, function () {
  var port = server.address().port;
  console.log('strict query demo listening on port %d\n', port);

  var requests = [
    '/',
    '/?a=1&b=two',
    '/?a=hello+world',
    '/?a%5Bb%5D=1',
    '/?__proto__=polluted&constructor=2',
    '/?a=1&%61=2',
    '/?%',
    '/?a=%C0%AF',
    '/?%E4%B8%AD=%E6%96%87'
  ];

  function requestNext() {
    if (requests.length === 0) {
      server.close();
      console.log('\ndone.');
      return;
    }

    var path = requests.shift();

    http.get('http://127.0.0.1:' + port + path, function (res) {
      var body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        console.log('GET %s -> %s', path, res.statusCode);
        console.log('  %s\n', body);
        requestNext();
      });
    }).on('error', function (err) {
      console.error('request failed:', err.message);
      requestNext();
    });
  }

  requestNext();
});
