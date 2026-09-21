'use strict'

var express = require('../')
  , expressRes = require('../lib/response')
  , request = require('supertest')
  , assert = require('node:assert')
  , Buffer = require('node:buffer').Buffer
  , stream = require('node:stream');

function asyncIterableFrom (values) {
  var iterable = {
    nextCalls: 0,
    returnCalls: 0
  };
  iterable[Symbol.asyncIterator] = function () {
    var index = 0;
    return {
      next: function () {
        iterable.nextCalls++;
        var value = values[index++];
        return Promise.resolve(value === undefined
          ? { value: undefined, done: true }
          : { value: value, done: false });
      },
      return: function () {
        iterable.returnCalls++;
        return Promise.resolve({ done: true });
      }
    };
  };
  return iterable;
}

function mockResponse (options) {
  options = options || {};
  var app = express();
  if (options.replacer) app.set('json replacer', options.replacer);
  if (options.escape) app.set('json escape', true);
  if (options.spaces !== undefined) app.set('json spaces', options.spaces);

  var res = new stream.PassThrough({ highWaterMark: options.highWaterMark || 16384 });
  res.app = app;
  res.req = { method: options.method || 'GET' };
  var headers = {};
  res.get = function (name) { return headers[name.toLowerCase()]; };
  res.set = function (name, value) { headers[name.toLowerCase()] = value; return this; };
  return res;
}

function mockWritableResponse (options) {
  options = options || {};
  var app = express();
  var pendingCallbacks = [];
  var res = new stream.Writable({
    highWaterMark: options.highWaterMark || 16384,
    write: function (chunk, encoding, callback) {
      res.chunks.push(chunk);
      if (options.autoFlush === false) {
        pendingCallbacks.push(callback);
      } else {
        callback();
      }
    }
  });
  res.app = app;
  res.req = { method: 'GET' };
  res.chunks = [];
  res.flush = function () {
    var callback = pendingCallbacks.shift();
    if (callback) callback();
  };
  var headers = {};
  res.get = function (name) { return headers[name.toLowerCase()]; };
  res.set = function (name, value) { headers[name.toLowerCase()] = value; return this; };
  return res;
}

function listenerCounts (res) {
  return ['drain', 'error', 'close', 'finish'].map(function (name) {
    return res.listenerCount(name);
  });
}

describe('res', function () {
  describe('.jsonLines(iterable, options)', function () {
    it('should stream each record as a single parseable line', function (done) {
      var app = express();

      app.use(function (req, res) {
        res.jsonLines([
          { text: 'line one\nline two' },
          { text: 'second\nrecord\nwith\nnewlines' }
        ]).catch(done);
      });

      request(app)
        .get('/')
        .expect('Content-Type', 'application/x-ndjson; charset=utf-8')
        .expect(200)
        .expect(function (res) {
          var lines = res.text.split('\n').filter(Boolean);
          assert.strictEqual(lines.length, 2);
          assert.deepStrictEqual(lines.map(function (l) { return JSON.parse(l); }), [
            { text: 'line one\nline two' },
            { text: 'second\nrecord\nwith\nnewlines' }
          ]);
        })
        .end(done);
    });

    it('should accept async iterables and ignore json spaces', function (done) {
      var app = express();
      app.set('json spaces', 2);

      app.use(function (req, res) {
        res.jsonLines(asyncIterableFrom([{ a: 1 }, { b: 2 }])).catch(done);
      });

      request(app)
        .get('/')
        .expect(200)
        .expect(function (res) {
          assert.strictEqual(res.text, '{"a":1}\n{"b":2}\n');
          res.text.split('\n').filter(Boolean).forEach(function (l) { JSON.parse(l); });
        })
        .end(done);
    });

    it('should apply json replacer and json escape settings', function (done) {
      var app = express();
      app.set('json replacer', function (key, value) {
        return key === 'secret' ? undefined : value;
      });
      app.set('json escape', true);

      app.use(function (req, res) {
        res.jsonLines([{ tag: '<b>&</b>', secret: 1 }]).catch(done);
      });

      request(app)
        .get('/')
        .expect(200, '{"tag":"\\u003cb\\u003e\\u0026\\u003c/b\\u003e"}\n', done);
    });

    it('should not consume the iterable for HEAD requests', function (done) {
      var app = express();
      var iterable = asyncIterableFrom([{ a: 1 }]);

      app.use(function (req, res) {
        res.jsonLines(iterable).catch(done);
      });

      request(app)
        .head('/')
        .expect('Content-Type', 'application/x-ndjson; charset=utf-8')
        .expect(200)
        .expect(function (res) {
          assert.strictEqual(res.text, undefined);
          assert.strictEqual(iterable.nextCalls, 0);
        })
        .end(done);
    });

    describe('serialization errors', function () {
      it('should reject with ERR_NDJSON_UNDEFINED for undefined records', async function () {
        var res = mockResponse();
        await assert.rejects(
          expressRes.jsonLines.call(res, [undefined]),
          function (err) {
            assert.strictEqual(err.code, 'ERR_NDJSON_UNDEFINED');
            assert.ok(err instanceof TypeError);
            return true;
          });
        assert.strictEqual(res.destroyed, false);
        assert.strictEqual(res.writableEnded, false);
      });

      it('should reject with ERR_NDJSON_BIGINT for BigInt records', async function () {
        var res = mockResponse();
        await assert.rejects(
          expressRes.jsonLines.call(res, [10n]),
          function (err) {
            assert.strictEqual(err.code, 'ERR_NDJSON_BIGINT');
            return true;
          });
      });

      it('should reject with ERR_NDJSON_CIRCULAR for circular records', async function () {
        var res = mockResponse();
        var record = {};
        record.self = record;
        await assert.rejects(
          expressRes.jsonLines.call(res, [record]),
          function (err) {
            assert.strictEqual(err.code, 'ERR_NDJSON_CIRCULAR');
            return true;
          });
      });

      it('should reject non-iterable input', async function () {
        var res = mockResponse();
        await assert.rejects(
          expressRes.jsonLines.call(res, 42),
          /Iterable or AsyncIterable/);
      });
    });

    describe('maxBytes', function () {
      it('should allow a record exactly at the UTF-8 byte limit', async function () {
        var res = mockResponse();
        var record = { v: '\u00e9\u00e9' };
        assert.strictEqual(Buffer.byteLength(JSON.stringify(record), 'utf8'), 12);
        await expressRes.jsonLines.call(res, [record], { maxBytes: 12 });
        assert.strictEqual(res.read().toString(), '{"v":"\u00e9\u00e9"}\n');
      });

      it('should reject a record one byte over the limit', async function () {
        var res = mockResponse();
        await assert.rejects(
          expressRes.jsonLines.call(res, [{ v: '\u00e9\u00e9' }], { maxBytes: 11 }),
          function (err) {
            assert.strictEqual(err.code, 'ERR_NDJSON_MAX_BYTES');
            assert.ok(err instanceof RangeError);
            return true;
          });
        assert.strictEqual(res.read(), null);
      });

      it('should reject invalid maxBytes options', async function () {
        var res = mockResponse();
        await assert.rejects(
          expressRes.jsonLines.call(res, [], { maxBytes: -1 }),
          RangeError);
      });
    });

    describe('failure before the first write', function () {
      it('should leave the response usable by the caller', function (done) {
        var app = express();

        app.use(function (req, res) {
          res.jsonLines([undefined]).catch(function (err) {
            assert.strictEqual(err.code, 'ERR_NDJSON_UNDEFINED');
            res.status(500).json({ error: 'export failed' });
          });
        });

        request(app)
          .get('/')
          .expect('Content-Type', 'application/json; charset=utf-8')
          .expect(500, '{"error":"export failed"}', done);
      });
    });

    describe('failure after output started', function () {
      it('should destroy the response and reject without an error page', async function () {
        var res = mockResponse();
        var circular = {};
        circular.self = circular;

        await assert.rejects(
          expressRes.jsonLines.call(res, [{ ok: 1 }, circular, { never: true }]),
          function (err) {
            assert.strictEqual(err.code, 'ERR_NDJSON_CIRCULAR');
            return true;
          });

        assert.strictEqual(res.destroyed, true);
        var chunks = [];
        var chunk;
        while ((chunk = res.read()) !== null) chunks.push(chunk);
        assert.strictEqual(Buffer.concat(chunks).toString(), '{"ok":1}\n');
        assert.deepStrictEqual(listenerCounts(res), [0, 0, 0, 0]);
      });
    });

    describe('backpressure', function () {
      it('should not call next() again until drain after write returns false', async function () {
        var res = mockWritableResponse({ highWaterMark: 8, autoFlush: false });
        var iterable = asyncIterableFrom([
          { big: '0123456789' },
          { big: 'abcdefghij' },
          { done: true }
        ]);

        var promise = expressRes.jsonLines.call(res, iterable);
        await new Promise(function (resolve) { setImmediate(resolve); });

        // first record (17 bytes) overflows the 8-byte buffer
        assert.strictEqual(iterable.nextCalls, 1);
        assert.strictEqual(res.writableNeedDrain, true);

        await new Promise(function (resolve) { setImmediate(resolve); });
        assert.strictEqual(iterable.nextCalls, 1);

        // release the backpressure manually
        var drained = new Promise(function (resolve) { res.once('drain', resolve); });
        res.flush();
        await drained;
        assert.strictEqual(iterable.nextCalls, 2);

        drained = new Promise(function (resolve) { res.once('drain', resolve); });
        res.flush();
        await drained;
        assert.strictEqual(iterable.nextCalls, 3);

        res.flush();
        await promise;
        assert.deepStrictEqual(listenerCounts(res), [0, 0, 0, 0]);
      });

      it('should converge once when the client disconnects while waiting for drain', async function () {
        var res = mockWritableResponse({ highWaterMark: 8, autoFlush: false });
        var iterable = asyncIterableFrom([
          { big: '0123456789' },
          { big: 'abcdefghij' }
        ]);

        var rejection = assert.rejects(
          expressRes.jsonLines.call(res, iterable),
          /response closed before completion/);

        await new Promise(function (resolve) { setImmediate(resolve); });
        assert.strictEqual(iterable.nextCalls, 1);
        assert.strictEqual(res.writableNeedDrain, true);

        res.destroy();
        await rejection;
        await new Promise(function (resolve) { setImmediate(resolve); });

        assert.strictEqual(iterable.nextCalls, 1);
        assert.strictEqual(iterable.returnCalls, 1);
        assert.deepStrictEqual(listenerCounts(res), [0, 0, 0, 0]);
      });
    });

    describe('iterator cleanup', function () {
      it('should call iterator.return() on iterator throw', async function () {
        var res = mockResponse();
        var returnCalls = 0;
        var iterable = {};
        iterable[Symbol.asyncIterator] = function () {
          return {
            next: function () { return Promise.reject(new Error('upstream failed')); },
            return: function () {
              returnCalls++;
              return Promise.resolve({ done: true });
            }
          };
        };

        await assert.rejects(
          expressRes.jsonLines.call(res, iterable),
          /upstream failed/);
        assert.strictEqual(returnCalls, 1);
        assert.strictEqual(res.destroyed, false);
      });

      it('should surface the original error when iterator.return() rejects', async function () {
        var res = mockResponse();
        var returnError = new Error('return failed');
        var iterable = {};
        iterable[Symbol.asyncIterator] = function () {
          return {
            next: function () { return Promise.resolve({ value: undefined, done: false }); },
            return: function () { return Promise.reject(returnError); }
          };
        };

        await assert.rejects(
          expressRes.jsonLines.call(res, iterable),
          function (err) {
            assert.strictEqual(err.code, 'ERR_NDJSON_UNDEFINED');
            assert.strictEqual(err.iteratorReturnError, returnError);
            return true;
          });
        assert.deepStrictEqual(listenerCounts(res), [0, 0, 0, 0]);
      });

      it('should not write late next() results after settling', async function () {
        var res = mockWritableResponse({ highWaterMark: 8 });
        var releaseNext;
        var iterable = {};
        iterable[Symbol.asyncIterator] = function () {
          var calls = 0;
          return {
            next: function () {
              calls++;
              if (calls === 1) {
                return Promise.resolve({ value: { big: '0123456789' }, done: false });
              }
              return new Promise(function (resolve) { releaseNext = resolve; });
            },
            return: function () { return Promise.resolve({ done: true }); }
          };
        };

        var promise = expressRes.jsonLines.call(res, iterable);
        await new Promise(function (resolve) { setImmediate(resolve); });
        assert.strictEqual(typeof releaseNext, 'function');
        res.destroy();
        await assert.rejects(promise, /response closed before completion/);

        // a late next() resolution must not be written
        releaseNext({ value: { late: true }, done: false });
        await new Promise(function (resolve) { setImmediate(resolve); });
        assert.strictEqual(Buffer.concat(res.chunks).toString(), '{"big":"0123456789"}\n');
      });
    });

    describe('completion', function () {
      it('should resolve the promise exactly once on normal completion', async function () {
        var res = mockResponse();
        var resolved = 0;
        var iterable = asyncIterableFrom([{ a: 1 }]);

        await expressRes.jsonLines.call(res, iterable).then(function () { resolved++; });
        await new Promise(function (resolve) { setImmediate(resolve); });

        assert.strictEqual(resolved, 1);
        assert.strictEqual(iterable.returnCalls, 0);
        assert.strictEqual(res.read().toString(), '{"a":1}\n');
        assert.deepStrictEqual(listenerCounts(res), [0, 0, 0, 0]);
      });

      it('should send headers and end for an empty iterable', async function () {
        var res = mockResponse();
        await expressRes.jsonLines.call(res, []);
        assert.strictEqual(res.get('Content-Type'), 'application/x-ndjson; charset=utf-8');
        assert.strictEqual(res.writableEnded, true);
      });
    });
  });
});
