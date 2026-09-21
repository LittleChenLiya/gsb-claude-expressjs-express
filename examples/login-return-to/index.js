'use strict'

/**
 * Login "returnTo" redirect example using res.redirectSafe().
 *
 * The redirect policy is explicit, static configuration: a trusted
 * baseOrigin plus an exact set of allowed external origins. It is never
 * derived from the Host or X-Forwarded-Host headers of the request, so
 * enabling "trust proxy" cannot widen it.
 *
 * res.redirectSafe() only enforces that the redirect stays within the
 * origins you list. It does not and cannot verify that the destination
 * site itself is trustworthy or serves safe content.
 */

var express = require('../../')

var app = module.exports = express()

// Exact origins the login flow may send users to after sign-in.
var LOGIN_REDIRECT_POLICY = {
  baseOrigin: 'http://localhost:3000',
  allowedOrigins: ['https://sso.example.net']
}

app.use(express.urlencoded({ extended: false }))

app.get('/login', function (req, res) {
  res.send(
    '<form method="post" action="/login">' +
    '<input name="user" placeholder="user">' +
    '<input name="pass" type="password" placeholder="pass">' +
    '<input name="returnTo" placeholder="/dashboard">' +
    '<button>Sign in</button>' +
    '</form>'
  )
})

app.post('/login', function (req, res, next) {
  // ... pretend the credentials checked out
  var returnTo = req.body.returnTo || '/'

  try {
    // resolves, validates and sends the redirect on a single path
    res.redirectSafe(returnTo, LOGIN_REDIRECT_POLICY)
  } catch (err) {
    if (err && err.code === 'ERR_REDIRECT_TARGET_REJECTED') {
      // the caller decides the response; nothing was sent silently
      res.status(400).send('returnTo is not an allowed redirect target')
      return
    }
    next(err)
  }
})

/* istanbul ignore next */
if (!module.parent) {
  app.listen(3000)
  console.log('Express started on port 3000')
}

