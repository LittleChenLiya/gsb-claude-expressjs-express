# `express.ifMatch([options])`

Optional middleware that validates the HTTP [`If-Match`](https://www.rfc-editor.org/rfc/rfc9110#section-13.1.1)
precondition on write requests (`PUT`, `PATCH`, `DELETE`, ...) using the
[strong comparison function](https://www.rfc-editor.org/rfc/rfc9110#section-8.8.1.1).

The middleware does **not** update any storage. The caller supplies the
current strong validator of the target resource; the middleware only parses
the precondition, compares it with that validator, and either calls `next()`
or produces an error response.

```js
var express = require('express')

app.put('/items/:id',
  express.ifMatch({
    requireHeader: true,
    etag: function (req) {
      // resolve to the current STRONG entity-tag of the target
      // representation, e.g. '"v12"', or null if it does not exist.
      return store.find(req.params.id).then(function (doc) {
        return doc ? '"' + doc.version + '"' : null
      })
    }
  }),
  function (req, res) {
    // reached only when If-Match evaluated to true
    res.sendStatus(204)
  }
)
```

## Options

### `etag` (required)

A function returning the current strong entity-tag of the target resource.
Either form is supported:

- `etag(req)` returning a `Promise` (or a thenable),
- `etag(req, callback)` where `callback(err, etag)` follows the Node
  callback convention, or
- `etag(req)` returning the tag synchronously.

The value must be the complete **quoted** tag exactly as sent in the
response's `ETag` header (for example `'"v12"'` or `'"1,v3"'`), or
`null`/`undefined` when the selected representation does not exist.

The function is invoked **at most once per request**, and only after the
`If-Match` header has been parsed successfully and actually needs to be
compared with the current state. On the success path the value is also made
available as `req.currentEtag` so the downstream handler can reuse it
without querying again.

If the provider rejects, throws, or calls back with an error, the error is
propagated to `next(err)`. A lookup failure is **not** treated as "no match"
and never produces a `412`; it becomes a normal application error (typically
`500`, depending on the error handler).

### `requireHeader` (optional, default `false`)

When `true`, a request without an `If-Match` header is rejected with
`428 Precondition Required`.

When `false`, a missing header means the precondition is ignored (the RFC
9110 default) and `next()` is called immediately without querying the
current tag.

## Status codes

| Situation | Status |
| --- | --- |
| Missing header with `requireHeader: true` | `428 Precondition Required` |
| Malformed `If-Match` header value | `400 Bad Request` |
| Precondition evaluated to false | `412 Precondition Failed` |
| Precondition evaluated to true | `next()` is called |

## Parsing rules

- The header is parsed as `*` or as a comma-separated list (`1#entity-tag`).
- Each tag must be a double-quoted entity-tag, optionally prefixed with the
  case-sensitive `W/` weak marker.
- Commas **inside** a quoted tag are tag content and are not separators.
  An `If-Match: "a,b"` header is a single tag that matches a current tag of
  `"a,b"`.
- Surrounding optional whitespace (spaces/tabs) around tags and commas is
  tolerated. Trailing/empty list elements and `*` combined with tags are
  rejected.
- Under the strong comparison function a weak tag (`W/"..."`) **never**
  matches, even if its opaque tag is byte-identical to the current strong
  validator. A weak current validator does not match any listed tag either.
- `*` is evaluated against the explicit existence state reported by the
  provider: it passes when the provider returns a tag and fails with `412`
  when the provider returns `null`.

## Concurrency: the downstream update is still your responsibility

Passing this middleware does **not** serialize updates and does **not**
eliminate the check-then-act race window. Between the middleware's
comparison and the downstream write, another request can change the
resource. In particular, two concurrent requests carrying the same valid
tag can **both** pass this check; only one of them must win the update.

The downstream write MUST therefore repeat the version condition
**atomically inside the storage operation**, for example:

- SQL: `UPDATE items SET ..., version = version + 1 WHERE id = ? AND
  version = ?`, then treat zero affected rows as `412`;
- a key-value store compare-and-swap / test-and-set on the version;
- a transaction with an appropriate isolation level or
  `SELECT ... FOR UPDATE`;
- any other storage-native optimistic-concurrency control.

The middleware only rejects requests whose precondition is already known to
be stale at check time; it cannot guarantee the state stays unchanged until
the write commits. A runnable demonstration of both the check and an atomic
compare-and-set (including two concurrent requests where one passes the
check yet loses the update) lives in
[`examples/if-match`](../../examples/if-match).
