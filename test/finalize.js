'use strict';

var assert = require('node:assert');
var http = require('node:http');
var EventEmitter = require('node:events').EventEmitter;
var express = require('../');
var request = require('supertest');

/**
 * A controllable promise ("deferred") so tests can decide exactly when an
 * async cleanup resolves.
 */
function deferred () {
  var resolve;
  var reject;
  var promise = new Promise(function (res, rej) {
    resolve = res;
    reject = rej;
  });
  return { promise: promise, resolve: resolve, reject: reject };
}

/**
 * Flush the microtask + setImmediate queue so promise chains settle.
 */
function flush () {
  return new Promise(function (resolve) {
    setImmediate(resolve);
  });
}

describe('express.finalize()', function () {
  it('runs cleanups in reverse registration order after a normal response', function (done) {
    var order = [];
    var app = express();

    app.use(express.finalize());
    app.get('/', function (req, res) {
      req.finalize.add(function () { order.push('A'); });
      req.finalize.add(function () { order.push('B'); });
      res.send('ok');
    });

    request(app)
      .get('/')
      .expect(200, 'ok')
      .end(function (err) {
        if (err) return done(err);
        assert.deepEqual(order, ['B', 'A']);
        done();
      });
  });

  it('keeps running the remaining cleanups when one throws and reports the error', function (done) {
    var order = [];
    var errors = [];
    var app = express();

    app.use(express.finalize({
      onError: function (err) { errors.push(err); }
    }));
    app.get('/', function (req, res) {
      req.finalize.add(function () { order.push('A'); });
      req.finalize.add(function () {
        order.push('B');
        throw new Error('boom');
      });
      req.finalize.add(function () { order.push('C'); });
      res.send('ok');
    });

    request(app)
      .get('/')
      .expect(200)
      .end(function (err) {
        if (err) return done(err);
        // LIFO: C, then B (throws), then A still runs
        assert.deepEqual(order, ['C', 'B', 'A']);
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0].message, 'boom');
        done();
      });
  });

  it('groups multiple cleanup failures into an AggregateError', function (done) {
    var errors = [];
    var app = express();

    app.use(express.finalize({
      onError: function (err) { errors.push(err); }
    }));
    app.get('/', function (req, res) {
      req.finalize.add(function () { throw new Error('one'); });
      req.finalize.add(function () { throw new Error('two'); });
      res.send('ok');
    });

    request(app)
      .get('/')
      .expect(200)
      .end(function (err) {
        if (err) return done(err);
        assert.strictEqual(errors.length, 1);
        assert.ok(errors[0] instanceof AggregateError);
        assert.strictEqual(errors[0].errors.length, 2);
        assert.deepEqual(
          errors[0].errors.map(function (e) { return e.message; }),
          ['two', 'one']
        );
        done();
      });
  });

  it('triggers finalization on the error path (next(err))', function (done) {
    var calls = 0;
    var app = express();

    app.use(express.finalize());
    app.get('/', function (req, res, next) {
      req.finalize.add(function () { calls++; });
      next(new Error('route failure'));
    });
    // explicit error handler so the error response finishes
    app.use(function (err, req, res, next) {
      assert.strictEqual(err.message, 'route failure');
      res.status(500).end();
    });

    request(app)
      .get('/')
      .expect(500)
      .end(function (err) {
        if (err) return done(err);
        assert.strictEqual(calls, 1);
        done();
      });
  });

  it('does not expose req.finalize on routes without the middleware', function (done) {
    var app = express();

    app.get('/', function (req, res) {
      assert.strictEqual(req.finalize, undefined);
      res.send('ok');
    });

    request(app)
      .get('/')
      .expect(200, 'ok', done);
  });

  it('rejects new registrations after finalization has started', function () {
    var req = new EventEmitter();
    var res = new EventEmitter();

    express.finalize()(req, res, function () {});
    res.emit('finish');

    assert.throws(function () {
      req.finalize.add(function () {});
    }, /after finalization has started/);
  });

  it('rejects non-function cleanup arguments', function () {
    var req = new EventEmitter();
    var res = new EventEmitter();

    express.finalize()(req, res, function () {});

    assert.throws(function () {
      req.finalize.add('not a function');
    }, /expects a function/);
  });

  it('runs cleanups exactly once when finish and close both fire (double-event race)', function () {
    var calls = 0;
    var d = deferred();
    var req = new EventEmitter();
    var res = new EventEmitter();

    express.finalize()(req, res, function () {});
    req.finalize.add(function () {
      calls++;
      return d.promise;
    });

    // normal completion: finish fires, then close fires right after
    res.emit('finish');
    res.emit('close');
    res.emit('finish');
    res.emit('close');

    return flush().then(function () {
      assert.strictEqual(calls, 1);

      // the async cleanup is still pending; resolving it must not re-run
      d.resolve();
      return flush();
    }).then(function () {
      assert.strictEqual(calls, 1);
    });
  });

  it('runs cleanups exactly once when close arrives before finish (client abort)', function () {
    var calls = 0;
    var req = new EventEmitter();
    var res = new EventEmitter();

    express.finalize()(req, res, function () {});
    req.finalize.add(function () { calls++; });

    // connection terminated before the response finished
    res.emit('close');
    res.emit('finish');

    return flush().then(function () {
      assert.strictEqual(calls, 1);
    });
  });

  it('truly waits for asynchronous cleanup promises to settle', function () {
    var completed = false;
    var d = deferred();
    var req = new EventEmitter();
    var res = new EventEmitter();

    express.finalize()(req, res, function () {});
    req.finalize.add(function () {
      return d.promise.then(function () { completed = true; });
    });

    res.emit('finish');

    return flush().then(function () {
      // cleanup started but its promise is still pending: not done yet
      assert.strictEqual(completed, false);

      d.resolve();
      return flush();
    }).then(function () {
      assert.strictEqual(completed, true);
    });
  });

  it('awaits every async cleanup even when one rejects', function () {
    var order = [];
    var errors = [];
    var req = new EventEmitter();
    var res = new EventEmitter();

    express.finalize({
      onError: function (err) { errors.push(err); }
    })(req, res, function () {});

    req.finalize.add(function () {
      return Promise.resolve().then(function () { order.push('A'); });
    });
    req.finalize.add(function () {
      order.push('B');
      return Promise.reject(new Error('async boom'));
    });

    res.emit('finish');

    return flush().then(function () {
      // LIFO: B ran (its rejection is handled), then A still ran
      assert.deepEqual(order, ['B', 'A']);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].message, 'async boom');
    });
  });

  it('passes the trigger reason to each cleanup', function () {
    var reasons = [];
    var req = new EventEmitter();
    var res = new EventEmitter();

    express.finalize()(req, res, function () {});
    req.finalize.add(function (ctx) { reasons.push(ctx.reason); });

    res.emit('close');

    return flush().then(function () {
      assert.deepEqual(reasons, ['close']);
    });
  });

  it('cleans up exactly once when the client disconnects early (real socket)', function (done) {
    var calls = 0;
    var app = express();

    app.use(express.finalize());
    app.get('/', function (req, res) {
      req.finalize.add(function () { calls++; });
      // never finish the response: wait for the client to go away
      res.write('partial');
    });

    var server = app.listen(function () {
      var client = http.get({
        port: server.address().port,
        path: '/'
      }, function (res) {
        res.on('data', function () {});
        res.on('close', function () {
          // give the server a tick to observe the socket close
          setTimeout(function () {
            try {
              assert.strictEqual(calls, 1, 'cleanup ran exactly once');
              server.close(done);
            } catch (err) {
              done(err);
            }
          }, 50);
        });

        setImmediate(function () {
          client.destroy();
        });
      });
    });
  });
});
