'use strict';

var assert = require('assert');
var http = require('http');
var express = require('..');
var request = require('supertest');

/**
 * Controllable promise: resolve/reject from the test to make
 * asynchronous late writes deterministic.
 */
function deferred () {
  var d = {};
  d.promise = new Promise(function (resolve, reject) {
    d.resolve = resolve;
    d.reject = reject;
  });
  return d;
}

function diagnosticsApp (diagnostics, onEnd) {
  var app = express();
  app.use(express.responseDiagnostics({
    reporter: function (d) { diagnostics.push(d); },
    onEnd: onEnd
  }));
  return app;
}

describe('express.responseDiagnostics()', function () {
  it('should be a function exported from express', function () {
    assert.strictEqual(typeof express.responseDiagnostics, 'function');
  });

  describe('late write after res.send()', function () {
    it('should deliver only the first body and report one late write', function (done) {
      var diagnostics = [];
      var gate = deferred();
      var lateCalled = deferred();
      var app = diagnosticsApp(diagnostics);

      app.get('/', function (req, res) {
        res.send('first');
        gate.promise.then(function () {
          res.write('second');
          lateCalled.resolve();
        });
      });

      request(app)
        .get('/')
        .expect(200, 'first', function (err) {
          if (err) return done(err);
          gate.resolve();
          lateCalled.promise.then(function () {
            assert.strictEqual(diagnostics.length, 1);
            assert.strictEqual(diagnostics[0].method, 'write');
            assert.strictEqual(diagnostics[0].ended.kind, 'finish');
            assert.ok(diagnostics[0].ended.stack, 'end site stack reported');
            assert.ok(diagnostics[0].callStack, 'late call site stack reported');
            assert.ok(diagnostics[0].error instanceof Error);
            done();
          }, done);
        });
    });

    it('should reject a late res.send() without corrupting the first response', function (done) {
      var diagnostics = [];
      var gate = deferred();
      var lateCalled = deferred();
      var app = diagnosticsApp(diagnostics);

      app.get('/', function (req, res) {
        res.send('first');
        gate.promise.then(function () {
          res.send('second');
          lateCalled.resolve();
        });
      });

      request(app)
        .get('/')
        .expect(200, 'first', function (err) {
          if (err) return done(err);
          gate.resolve();
          lateCalled.promise.then(function () {
            assert.strictEqual(diagnostics.length, 1);
            assert.strictEqual(diagnostics[0].method, 'send');
            assert.strictEqual(diagnostics[0].ended.kind, 'finish');
            done();
          }, done);
        });
    });

    it('should report a late res.setHeader() after end', function (done) {
      var diagnostics = [];
      var gate = deferred();
      var lateCalled = deferred();
      var app = diagnosticsApp(diagnostics);

      app.get('/', function (req, res) {
        res.send('first');
        gate.promise.then(function () {
          res.setHeader('x-late', 'yes');
          lateCalled.resolve();
        });
      });

      request(app)
        .get('/')
        .expect(200, 'first', function (err) {
          if (err) return done(err);
          gate.resolve();
          lateCalled.promise.then(function () {
            assert.strictEqual(diagnostics.length, 1);
            assert.strictEqual(diagnostics[0].method, 'setHeader');
            done();
          }, done);
        });
    });
  });

  describe('connection aborted before end', function () {
    it('should classify the late write as close', function (done) {
      var diagnostics = [];
      var closeSeen = deferred();
      var app = diagnosticsApp(diagnostics, function (record) {
        if (record.kind === 'close') closeSeen.resolve();
      });

      app.get('/', function (req, res) {
        res.write('partial');
        closeSeen.promise.then(function () {
          res.write('late');
        });
      });

      var server = app.listen(0, function () {
        var port = server.address().port;
        var req = http.get({ port: port, path: '/' }, function (res) {
          res.on('data', function () {
            // abort the connection after the first chunk
            req.destroy();
          });
        });
        req.on('error', function () { /* expected reset */ });

        var timer = setTimeout(function () {
          finish(new Error('timed out waiting for close diagnostic'));
        }, 5000);

        function finish (err) {
          clearTimeout(timer);
          clearInterval(poll);
          server.close(function () { done(err); });
        }

        var poll = setInterval(function () {
          if (diagnostics.length === 0) return;
          try {
            assert.strictEqual(diagnostics.length, 1);
            assert.strictEqual(diagnostics[0].method, 'write');
            assert.strictEqual(diagnostics[0].ended.kind, 'close');
            finish();
          } catch (err) {
            finish(err);
          }
        }, 10);
      });
    });
  });

  describe('response destroyed', function () {
    it('should classify as destroy and keep the destroy error as cause', function (done) {
      var diagnostics = [];
      var destroyed = deferred();
      var cause = new Error('socket gone');
      var app = diagnosticsApp(diagnostics, function (record) {
        if (record.kind === 'destroy') destroyed.resolve();
      });

      app.get('/', function (req, res) {
        res.destroy(cause);
        destroyed.promise.then(function () {
          res.write('late');
        });
      });

      var server = app.listen(0, function () {
        var port = server.address().port;
        var req = http.get({ port: port, path: '/' }, function (res) {
          res.on('aborted', function () {});
          res.on('error', function () {});
        });
        req.on('error', function () { /* expected hang up */ });

        var timer = setTimeout(function () {
          finish(new Error('timed out waiting for destroy diagnostic'));
        }, 5000);

        function finish (err) {
          clearTimeout(timer);
          clearInterval(poll);
          server.close(function () { done(err); });
        }

        var poll = setInterval(function () {
          if (diagnostics.length === 0) return;
          try {
            assert.strictEqual(diagnostics.length, 1);
            assert.strictEqual(diagnostics[0].ended.kind, 'destroy');
            assert.strictEqual(diagnostics[0].error.cause, cause);
            finish();
          } catch (err) {
            finish(err);
          }
        }, 10);
      });
    });
  });

  describe('error chain', function () {
    it('should pass next(err) with its cause through the original error chain', function (done) {
      var diagnostics = [];
      var cause = new Error('root cause');
      var app = diagnosticsApp(diagnostics);

      app.get('/', function (req, res, next) {
        var err = new Error('boom');
        err.cause = cause;
        next(err);
      });

      app.use(function (err, req, res, next) {
        assert.strictEqual(err.cause, cause);
        res.status(500).send(err.cause.message);
      });

      request(app)
        .get('/')
        .expect(500, 'root cause', function (err) {
          if (err) return done(err);
          assert.strictEqual(diagnostics.length, 0);
          done();
        });
    });

    it('should not swallow genuine errors thrown before the first end', function (done) {
      var diagnostics = [];
      var app = diagnosticsApp(diagnostics);

      app.get('/', function (req, res) {
        var circular = {};
        circular.self = circular;
        res.json(circular); // throws TypeError synchronously
      });

      app.use(function (err, req, res, next) {
        assert.ok(err instanceof TypeError);
        res.status(500).send('json failed');
      });

      request(app)
        .get('/')
        .expect(500, 'json failed', function (err) {
          if (err) return done(err);
          assert.strictEqual(diagnostics.length, 0);
          done();
        });
    });
  });

  describe('diagnostics safety', function () {
    it('should survive a throwing reporter without touching the response', function (done) {
      var gate = deferred();
      var lateCalled = deferred();
      var app = express();
      app.use(express.responseDiagnostics({
        reporter: function () { throw new Error('reporter exploded'); }
      }));

      app.get('/', function (req, res) {
        res.send('first');
        gate.promise.then(function () {
          res.write('second');
          lateCalled.resolve();
        });
      });

      request(app)
        .get('/')
        .expect(200, 'first', function (err) {
          if (err) return done(err);
          gate.resolve();
          lateCalled.promise.then(function () { done(); }, done);
        });
    });
  });

  describe('routes without the middleware', function () {
    it('should behave as before', function (done) {
      var app = express();
      app.get('/', function (req, res) {
        res.send('hello');
      });

      request(app)
        .get('/')
        .expect(200, 'hello', done);
    });
  });
});
