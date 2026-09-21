/*!
 * Login return-to redirect using res.redirectSafe().
 *
 * The redirect policy is explicit: the application names its own
 * trusted origin as `baseOrigin` and lists the exact external
 * origins a post-login redirect may point to. Trust is never derived
 * from the `Host` or `X-Forwarded-Host` headers of the request.
 *
 * Note that the policy only constrains where the redirect points; it
 * does not verify the content served by the target site.
 *
 * Try it:
 *
 *    $ node examples/redirect-safe
 *    $ curl -i -X POST 'http://localhost:3000/login?returnTo=/dashboard'
 *    $ curl -i -X POST 'http://localhost:3000/login?returnTo=https://docs.example.com/start'
 *    $ curl -i -X POST 'http://localhost:3000/login?returnTo=https://evil.example'
 */

'use strict'

var express = require('../..')

var app = module.exports = express()

// The set of places a post-login redirect may go. The base origin is
// always allowed; allowedOrigins lists exact external origins
// (protocol, host and port must all match).
var redirectPolicy = {
  baseOrigin: 'http://localhost:3000',
  allowedOrigins: ['https://docs.example.com']
}

app.post('/login', function (req, res) {
  // ... authenticate the user here ...

  var returnTo = typeof req.query.returnTo === 'string'
    ? req.query.returnTo
    : '/dashboard'

  try {
    res.redirectSafe(returnTo, redirectPolicy)
  } catch (err) {
    if (err.code === 'ERR_REDIRECT_TARGET_REJECTED') {
      // The caller decides how to respond; nothing has been sent yet.
      res.status(400).send('Invalid returnTo: ' + err.message)
      return
    }
    throw err
  }
})

app.get('/dashboard', function (req, res) {
  res.send('logged in!')
})

/* istanbul ignore next */
if (!module.parent) {
  app.listen(3000)
  console.log('Express started on port 3000')
}
