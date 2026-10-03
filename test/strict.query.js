'use strict'

var assert = require('node:assert')
var express = require('../')
  , request = require('supertest');

describe('strictQuery middleware', function () {
  it('parses simple key/value pairs into req.strictQuery', function (done) {
    var app = createApp();

    request(app)
    .get('/?a=1&b=two')
    .expect(200, { a: '1', b: 'two' }, done);
  });

  it('decodes percent-escapes', function (done) {
    var app = createApp();

    request(app)
    .get('/?%61=%31')
    .expect(200, { a: '1' }, done);
  });

  it('decodes + as a space per form rules', function (done) {
    var app = createApp();

    request(app)
    .get('/?a=hello+world&b=c%2Bd')
    .expect(200, { a: 'hello world', b: 'c+d' }, done);
  });

  it('keeps bracket keys as literal keys, never nested objects', function (done) {
    var app = createApp();

    request(app)
    .get('/?a%5Bb%5D=1&a[c]=2')
    .expect(200, { 'a[b]': '1', 'a[c]': '2' }, done);
  });

  it('stores __proto__ as ordinary data', function (done) {
    var app = express();

    app.use(express.strictQuery());
    app.use(function (req, res) {
      res.send({
        strictQuery: req.strictQuery,
        protoIsNull: Object.getPrototypeOf(req.strictQuery) === null,
        polluted: Object.getPrototypeOf({}) === Object.getPrototypeOf(req.strictQuery)
      });
    });

    // object literals treat __proto__ as a prototype setter, so build
    // the expected body from JSON to keep it as a plain own property
    var expected = JSON.parse(
      '{"strictQuery":{"__proto__":"1","constructor":"2","prototype":"3"},' +
      '"protoIsNull":true,"polluted":false}'
    );

    request(app)
    .get('/?__proto__=1&constructor=2&prototype=3')
    .expect(200, expected, done);
  });

  it('rejects duplicate keys by decoded identity', function (done) {
    var app = createApp();

    request(app)
    .get('/?a=1&%61=2')
    .expect(400, {
      code: 'STRICT_QUERY_DUPLICATE',
      key: 'a',
      positions: [0, 4]
    }, done);
  });

  it('reports raw positions, not decoded offsets', function (done) {
    var app = createApp();

    request(app)
    .get('/?x=1&%61=2&a=3')
    .expect(400, {
      code: 'STRICT_QUERY_DUPLICATE',
      key: 'a',
      positions: [4, 10]
    }, done);
  });

  it('reports isolated percent signs with their raw position', function (done) {
    var app = createApp();

    request(app)
    .get('/?a=%2')
    .expect(400, {
      code: 'STRICT_QUERY_INVALID_ENCODING',
      position: 2
    }, done);
  });

  it('reports a trailing percent sign with its raw position', function (done) {
    var app = createApp();

    request(app)
    .get('/?a=100%')
    .expect(400, {
      code: 'STRICT_QUERY_INVALID_ENCODING',
      position: 5
    }, done);
  });

  it('reports bad UTF-8 with the raw position of the sequence', function (done) {
    var app = createApp();

    request(app)
    .get('/?a=%C0%AF')
    .expect(400, {
      code: 'STRICT_QUERY_INVALID_UTF8',
      position: 2
    }, done);
  });

  it('reports stray continuation bytes with their raw position', function (done) {
    var app = createApp();

    request(app)
    .get('/?%80=1')
    .expect(400, {
      code: 'STRICT_QUERY_INVALID_UTF8',
      position: 0
    }, done);
  });

  it('rejects before invoking the downstream handler', function (done) {
    var app = express();
    var called = false;

    app.use(express.strictQuery());
    app.use(function (req, res) {
      called = true;
      res.end();
    });
    app.use(function (err, req, res, next) {
      res.status(err.status).end();
    });

    request(app)
    .get('/?a=1&%61=2')
    .expect(400, function (err) {
      if (err) return done(err);
      assert.strictEqual(called, false);
      done();
    });
  });

  it('leaves the default req.query parsing unchanged', function (done) {
    var app = express();

    app.use(express.strictQuery());
    app.get('/', function (req, res) {
      // the default simple parser keeps brackets literal
      res.send({
        query: req.query,
        strictQuery: req.strictQuery
      });
    });
    app.use(function (err, req, res, next) {
      // req.query is still parsed by the default parser even when the
      // strict middleware rejects the request
      res.status(400).send({
        code: err.code,
        query: req.query
      });
    });

    request(app)
    .get('/?a%5Bb%5D=1')
    .expect(200, {
      query: { 'a[b]': '1' },
      strictQuery: { 'a[b]': '1' }
    }, done);
  });

  it('keeps duplicate keys in req.query while strictQuery rejects them', function (done) {
    var app = express();

    app.use(express.strictQuery());
    app.use(function (err, req, res, next) {
      res.status(400).send({
        code: err.code,
        query: req.query
      });
    });

    request(app)
    .get('/?a=1&a=2')
    .expect(400, {
      code: 'STRICT_QUERY_DUPLICATE',
      query: { a: ['1', '2'] }
    }, done);
  });

  it('gives every request its own isolated snapshot', function (done) {
    var app = express();
    var snapshots = [];

    app.use(express.strictQuery());
    app.use(function (req, res) {
      snapshots.push(req.strictQuery);
      res.send(req.strictQuery);
    });

    request(app)
    .get('/?a=1')
    .expect(200, { a: '1' })
    .end(function (err) {
      if (err) return done(err);
      request(app)
      .get('/?a=2')
      .expect(200, { a: '2' })
      .end(function (err) {
        if (err) return done(err);
        assert.strictEqual(snapshots.length, 2);
        assert.notStrictEqual(snapshots[0], snapshots[1]);
        assert.deepEqual(snapshots[0], { a: '1' });
        assert.deepEqual(snapshots[1], { a: '2' });
        done();
      });
    });
  });

  it('returns a frozen empty snapshot when there is no query', function (done) {
    var app = express();
    var snapshots = [];

    app.use(express.strictQuery());
    app.use(function (req, res) {
      snapshots.push(req.strictQuery);
      res.send({
        keys: Object.keys(req.strictQuery),
        frozen: Object.isFrozen(req.strictQuery),
        protoIsNull: Object.getPrototypeOf(req.strictQuery) === null
      });
    });

    request(app)
    .get('/')
    .expect(200, { keys: [], frozen: true, protoIsNull: true })
    .end(function (err) {
      if (err) return done(err);
      request(app)
      .get('/')
      .expect(200, { keys: [], frozen: true, protoIsNull: true })
      .end(function (err) {
        if (err) return done(err);
        // the empty snapshot is immutable and safe to share
        assert.strictEqual(snapshots[0], snapshots[1]);
        done();
      });
    });
  });

  it('does not let a request mutate a later request snapshot', function (done) {
    var middleware = express.strictQuery();
    var req1 = { url: '/?a=1', originalUrl: '/?a=1' };
    var req2 = { url: '/?a=2', originalUrl: '/?a=2' };

    middleware(req1, {}, function (err) {
      assert.ifError(err);
      assert.throws(function () { req1.strictQuery.a = 5; }, TypeError);
      assert.throws(function () { delete req1.strictQuery.a; }, TypeError);

      middleware(req2, {}, function (err) {
        assert.ifError(err);
        assert.strictEqual(req2.strictQuery.a, '2');
        done();
      });
    });
  });

  it('treats keys without a value as empty strings', function (done) {
    var app = createApp();

    request(app)
    .get('/?a&b=')
    .expect(200, { a: '', b: '' }, done);
  });

  it('ignores empty segments', function (done) {
    var app = createApp();

    request(app)
    .get('/?a=1&&b=2')
    .expect(200, { a: '1', b: '2' }, done);
  });
});

function createApp() {
  var app = express();

  app.use(express.strictQuery());
  app.use(function (req, res) {
    var body = req.strictQuery;

    if (Object.keys(body).length === 0 && Object.getPrototypeOf(body) === null) {
      // keep the empty snapshot observable through JSON
      body = {};
    }

    res.send(body);
  });
  app.use(function (err, req, res, next) {
    res.status(err.status || 500).send({
      code: err.code,
      key: err.key,
      position: err.position,
      positions: err.positions
    });
  });

  return app;
}
