'use strict';

/**
 * Short HTTP demo for the finalization stack middleware.
 *
 * Resource lifecycle (per request):
 *
 *   1. ACQUIRE  - the route handler obtains a resource (here a fake
 *                 connection) and registers a cleanup with req.finalize.add.
 *   2. USE      - the response is sent.
 *   3. RELEASE  - when the response finishes (or the client disconnects),
 *                 cleanups run in reverse registration order (LIFO), awaited
 *                 if they return a Promise. A failing cleanup is reported to
 *                 onError without stopping the others.
 *
 * Run:
 *
 *   node examples/finalize
 *   curl http://localhost:3000/
 *   curl http://localhost:3000/slow        # watch the server wait for cleanup
 *   curl http://localhost:3000/explode    # one cleanup fails, the other runs
 */

var express = require('../../');

var app = module.exports = express();

app.use(express.finalize({
  onError: function onError (err) {
    console.error('[finalize] cleanup error:', err.message);
  }
}));

// fake resource: a connection with a close() that can fail
function acquire (name, opts) {
  opts = opts || {};
  console.log('[acquire] %s', name);
  return {
    close: function close () {
      console.log('[release] %s', name);
      if (opts.fail) {
        return Promise.reject(new Error(name + ' close failed'));
      }
      if (opts.delay) {
        return new Promise(function (resolve) {
          setTimeout(resolve, opts.delay);
        }).then(function () {
          console.log('[release] %s (async done)', name);
        });
      }
    }
  };
}

app.get('/', function (req, res) {
  var connA = acquire('A');
  var connB = acquire('B');

  req.finalize.add(function () { return connA.close(); });
  req.finalize.add(function () { return connB.close(); });

  res.send('ok');
});

app.get('/slow', function (req, res) {
  var conn = acquire('slow-resource', { delay: 500 });
  req.finalize.add(function () { return conn.close(); });
  res.send('ok');
});

app.get('/explode', function (req, res) {
  var good = acquire('good');
  var bad = acquire('bad', { fail: true });

  req.finalize.add(function () { return good.close(); });
  req.finalize.add(function () { return bad.close(); });

  res.send('ok');
});

/* istanbul ignore next */
if (!module.parent) {
  app.listen(3000, function () {
    console.log('finalize demo listening on http://localhost:3000');
  });
}
