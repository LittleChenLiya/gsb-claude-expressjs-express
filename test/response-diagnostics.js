/*!
 * express
 * Copyright(c) 2009-2013 TJ Holowaychuk
 * Copyright(c) 2024 Express Contributors
 * MIT Licensed
 */

'use strict';

var assert = require('node:assert');
var http = require('node:http');
var express = require('../');
var request = require('supertest');
var responseDiagnostics = require('../lib/middleware/response-diagnostics');

function deferred() {
  var resolve;
  var reject;
  var promise = new Promise(function (res, rej) {
    resolve = res;
    reject = rej;
  });
  return { promise: promise, resolve: resolve, reject: reject };
}

describe('responseDiagnostics', function () {
  it('should be a function', function () {
    assert.strictEqual(typeof responseDiagnostics, 'function');
  });

  it('should not instrument the response when not mounted', function (done) {
    var app = express();
    app.get('/', function (req, res) {
      res.send('first');
      setImmediate(function () {
        res.write('late');
      });
    });
    request(app)
      .get('/')
      .expect(200, 'first')
      .end(done);
  });

  describe('when mounted', function () {
    it('should reject a late write after send and report one diagnostic', function (done) {
      var diagnostics = [];
      var app = express();
      app.use(responseDiagnostics({
        logger: function (d) { diagnostics.push(d); }
      }));
      app.get('/', function (req, res) {
        res.send('first');
        setImmediate(function () {
          res.write('late');
        });
      });
      request(app)
        .get('/')
        .expect(200, 'first')
        .end(function (err) {
          if (err) return done(err);
          assert.strictEqual(diagnostics.length, 1, 'expected exactly one diagnostic');
          assert.strictEqual(diagnostics[0].method, 'write');
          assert.strictEqual(diagnostics[0].classification, 'finish');
          assert.strictEqual(diagnostics[0].lateCallCount, 1);
          done();
        });
    });

    it('should reject a late send after end', function (done) {
      var diagnostics = [];
      var app = express();
      app.use(responseDiagnostics({
        logger: function (d) { diagnostics.push(d); }
      }));
      app.get('/', function (req, res) {
        res.send('first');
        setImmediate(function () {
          res.send('second');
        });
      });
      request(app)
        .get('/')
        .expect(200, 'first')
        .end(function (err) {
          if (err) return done(err);
          assert.strictEqual(diagnostics.length, 1);
          assert.strictEqual(diagnostics[0].method, 'send');
          assert.strictEqual(diagnostics[0].classification, 'finish');
          done();
        });
    });

    it('should reject a late setHeader after end', function (done) {
      var diagnostics = [];
      var app = express();
      app.use(responseDiagnostics({
        logger: function (d) { diagnostics.push(d); }
      }));
      app.get('/', function (req, res) {
        res.send('first');
        setImmediate(function () {
          res.setHeader('X-Foo', 'bar');
        });
      });
      request(app)
        .get('/')
        .expect(200, 'first')
        .end(function (err) {
          if (err) return done(err);
          assert.strictEqual(diagnostics.length, 1);
          assert.strictEqual(diagnostics[0].method, 'setHeader');
          assert.strictEqual(diagnostics[0].classification, 'finish');
          done();
        });
    });

    it('should report the end node and the late call site', function (done) {
      var diagnostics = [];
      var app = express();
      app.use(responseDiagnostics({
        logger: function (d) { diagnostics.push(d); }
      }));
      app.get('/', function (req, res) {
        res.send('first');
        setImmediate(function () {
          res.write('late');
        });
      });
      request(app)
        .get('/')
        .expect(200, 'first')
        .end(function (err) {
          if (err) return done(err);
          assert.strictEqual(diagnostics.length, 1);
          var d = diagnostics[0];
          assert.ok(typeof d.endSite === 'string' && d.endSite.length > 0,
            'expected endSite to be a non-empty string');
          assert.ok(typeof d.callSite === 'string' && d.callSite.length > 0,
            'expected callSite to be a non-empty string');
          done();
        });
    });

    it('should preserve the error cause in the diagnostic', function (done) {
      var diagnostics = [];
      var app = express();
      app.use(responseDiagnostics({
        logger: function (d) { diagnostics.push(d); }
      }));
      app.get('/', function (req, res) {
        res.send('first');
        setImmediate(function () {
          res.write('late');
        });
      });
      request(app)
        .get('/')
        .expect(200, 'first')
        .end(function (err) {
          if (err) return done(err);
          assert.strictEqual(diagnostics.length, 1);
          var d = diagnostics[0];
          assert.ok(d.error, 'expected diagnostic.error to be set');
          assert.ok(d.error.cause, 'expected diagnostic.error.cause to be set');
          assert.strictEqual(d.error.cause.code, 'ERR_STREAM_WRITE_AFTER_END');
          assert.strictEqual(d.error.code, 'ERR_RESPONSE_ALREADY_ENDED');
          done();
        });
    });

    it('should classify a late write after connection abort as close', function (done) {
      var diagnostics = [];
      var app = express();
      app.use(responseDiagnostics({
        logger: function (d) { diagnostics.push(d); }
      }));
      var capturedRes;
      var responseClosed = deferred();
      app.get('/', function (req, res) {
        capturedRes = res;
        res.on('close', function () {
          responseClosed.resolve();
        });
      });

      var server = app.listen(0, function () {
        var port = server.address().port;
        var client = http.get('http://localhost:' + port, function (res) {
          res.resume();
        });
        client.on('error', function () {
          // Swallow the client-side abort error.
        });
        setTimeout(function () {
          client.destroy();
        }, 15);
      });

      responseClosed.promise.then(function () {
        capturedRes.write('late');
        setTimeout(function () {
          try {
            assert.strictEqual(diagnostics.length, 1, 'expected exactly one diagnostic');
            assert.strictEqual(diagnostics[0].method, 'write');
            assert.strictEqual(diagnostics[0].classification, 'close');
            server.close(done);
          } catch (err) {
            server.close(function () { done(err); });
          }
        }, 50);
      });
    });

    it('should classify an explicit destroy as destroy', function (done) {
      var diagnostics = [];
      var app = express();
      app.use(responseDiagnostics({
        logger: function (d) { diagnostics.push(d); }
      }));
      var capturedRes;
      var responseDestroyed = deferred();
      app.get('/', function (req, res) {
        capturedRes = res;
        res.on('close', function () {
          responseDestroyed.resolve();
        });
        setImmediate(function () {
          res.destroy();
        });
      });

      var server = app.listen(0, function () {
        var port = server.address().port;
        http.get('http://localhost:' + port, function (res) {
          res.resume();
        }).on('error', function () {
          // Swallow.
        });
      });

      responseDestroyed.promise.then(function () {
        capturedRes.write('late');
        setTimeout(function () {
          try {
            assert.strictEqual(diagnostics.length, 1);
            assert.strictEqual(diagnostics[0].method, 'write');
            assert.strictEqual(diagnostics[0].classification, 'destroy');
            server.close(done);
          } catch (err) {
            server.close(function () { done(err); });
          }
        }, 50);
      });
    });

    it('should not swallow real errors before the first end', function (done) {
      var app = express();
      app.use(responseDiagnostics());
      app.get('/', function (req, res, next) {
        next(new Error('boom'));
      });
      app.use(function (err, req, res, next) {
        res.status(500).send('error: ' + err.message);
      });
      request(app)
        .get('/')
        .expect(500, 'error: boom')
        .end(done);
    });

    it('should not instrument the response twice', function (done) {
      var diagnostics = [];
      var app = express();
      app.use(responseDiagnostics({
        logger: function (d) { diagnostics.push(d); }
      }));
      app.use(responseDiagnostics({
        logger: function (d) { diagnostics.push(d); }
      }));
      app.get('/', function (req, res) {
        res.send('first');
        setImmediate(function () {
          res.write('late');
        });
      });
      request(app)
        .get('/')
        .expect(200, 'first')
        .end(function (err) {
          if (err) return done(err);
          assert.strictEqual(diagnostics.length, 1);
          done();
        });
    });

    it('should not write to the response from the diagnostic itself', function (done) {
      var diagnostics = [];
      var app = express();
      app.use(responseDiagnostics({
        logger: function (d) { diagnostics.push(d); }
      }));
      app.get('/', function (req, res) {
        res.send('first');
        setImmediate(function () {
          res.write('late');
        });
      });
      request(app)
        .get('/')
        .expect(200, 'first')
        .end(function (err, res) {
          if (err) return done(err);
          assert.strictEqual(res.text, 'first');
          assert.strictEqual(diagnostics.length, 1);
          done();
        });
    });
  });
});
