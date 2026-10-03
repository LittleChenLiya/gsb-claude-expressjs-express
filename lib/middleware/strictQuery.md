# express.strictQuery

Opt-in middleware that parses the query component of the request URL into
a **separate** request property, `req.strictQuery`. It never changes the
built-in `req.query` getter, which keeps its default (`"simple"`)
behavior.

## Why

The default parser silently aggregates repeated keys and accepts whatever
percent-encoding the platform tolerates. When a duplicate key or an
encoding mistake must be a hard error instead, install this middleware
explicitly.

## Usage

```js
var express = require('express')
var app = express()

app.use(express.strictQuery())

app.get('/', function (req, res) {
  // req.query is untouched; req.strictQuery is the strict snapshot
  res.json(req.strictQuery)
})
```

Invalid requests are rejected with a `400 Bad Request` before the route
handler is called. The forwarded error carries `err.code` and
`err.position` (a zero-based offset into the raw query string):

| code                         | meaning                                              |
| ---------------------------- | ---------------------------------------------------- |
| `DUPLICATE_QUERY_KEY`        | two pairs decode to the same key                     |
| `MALFORMED_PERCENT_ENCODING` | a `%` not followed by two hex digits                 |
| `INVALID_UTF8`               | percent-decoded bytes (or raw text) are not UTF-8    |

A custom error handler can read those fields:

```js
app.use(function (err, req, res, next) {
  if (err.status !== 400) return next(err)
  res.status(400).json({
    error: err.message,
    code: err.code,
    position: err.position
  })
})
```

## Parsing rules

- The query component is taken from the **original URL** and split on
  `&`; neither the order nor the raw spelling is normalized first.
- Each key/value is strictly percent-decoded byte by byte and decoded as
  UTF-8. A lone `%` (e.g. `%2`) produces
  `MALFORMED_PERCENT_ENCODING`; bad byte sequences (e.g. `%E2%82`)
  produce `INVALID_UTF8`. Both report the **raw** character offset, not
  an offset into the decoded string.
- `+` is decoded as a space, following the explicit
  `application/x-www-form-urlencoded` form rule. Pass
  `{ plus: 'keep' }` to preserve literal plus signs.
- Brackets are not special: `a%5Bb%5D=1` yields the literal key
  `"a[b]"`. No arrays and no nested objects are ever produced.
- Duplicate detection happens **after** percent-decoding. `a=1&%61=2`
  is therefore a duplicate of key `"a"` and the error reports both raw
  positions (`0 and 4`).
- The result is a **frozen, null-prototype** object whose keys are
  non-writable data properties. `__proto__`, `constructor` and similar
  names are ordinary data and cannot pollute `Object.prototype`.
- With no query component (or an empty one), the middleware returns an
  empty frozen snapshot. The same empty snapshot object is shared across
  requests, so per-request parsing results can never leak into each
  other.

## Options

`express.strictQuery(options)` accepts:

- `property` (`String`, default `'strictQuery'`): request property that
  receives the parsed snapshot.
- `plus` (`'space'` or `'keep'`, default `'space'`): whether `+` becomes
  a space (form rule) or stays a literal plus sign.

The underlying parser is also exported for use outside of a request:

```js
var parse = require('express/lib/middleware/strictQuery').parse
var params = parse('a%5Bb%5D=1') // { 'a[b]': '1' }, frozen
```

## Examples

Acceptance behavior at a glance:

| query                 | result / error                                         |
| --------------------- | ------------------------------------------------------ |
| _(no query)_          | `{}` (empty frozen snapshot)                           |
| `a=1`                 | `{ a: '1' }`                                           |
| `a=1&%61=2`           | 400 duplicate `"a"` at positions 0 and 4               |
| `a%5Bb%5D=1`          | `{ 'a[b]': '1' }`                                      |
| `__proto__=evil`      | `{ '__proto__': 'evil' }` as plain data                |
| `q=hello+world`       | `{ q: 'hello world' }`                                 |
| `bad=%2`              | 400 malformed percent-encoding at raw offset 4         |
| `bad=%E2%82`          | 400 invalid UTF-8 at raw offset 4                      |

A runnable demonstration, including an httptest-style self-check over
real HTTP requests, lives in
[`examples/strict-query`](../../../examples/strict-query).

