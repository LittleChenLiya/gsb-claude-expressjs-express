/*!
 * express
 * Copyright(c) 2009-2013 TJ Holowaychuk
 * Copyright(c) 2024 Express Contributors
 * MIT Licensed
 */

'use strict';

/**
 * Module dependencies.
 */

var express = require('../../');
var responseDiagnostics = require('../../lib/middleware/response-diagnostics');

var app = module.exports = express();

// Mount the diagnostics middleware explicitly. A custom logger prints the
// diagnostic to stderr; the middleware itself never writes to the response.
app.use(responseDiagnostics({
  logger: function (diagnostic) {
    process.stderr.write('[response-diagnostics] late ' + diagnostic.method +
      ' after ' + diagnostic.classification + '\n');
    process.stderr.write('  end node: ' + diagnostic.endSite + '\n');
    process.stderr.write('  late call: ' + diagnostic.callSite + '\n');
    process.stderr.write('  cause: ' + (diagnostic.error.cause && diagnostic.error.cause.code) + '\n');
  }
}));

app.get('/', function (req, res) {
  res.send('first');
  // Simulate a late write after the response has ended.
  setImmediate(function () {
    res.write('late');
  });
});

/* istanbul ignore next */
if (!module.parent) {
  app.listen(3000);
  console.log('Express started on port 3000');
}
