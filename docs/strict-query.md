# Strict query middleware

`express.strictQuery()` is an opt-in middleware that parses the raw query
string of the request URL into a read-only snapshot exposed as
`req.strictQuery`. The default `req.query` parsing is left completely
untouched.

## Usage

```js
var express = require('express');

var app = express();

app.use(express.strictQuery());

app.get('/', function (req, res) {
  // req.strictQuery is a frozen, null-prototype object
  res.send(req.strictQuery);
});
```

Mount it on the application, a router, or an individual route like any
other middleware.

## Behavior

The raw query string is split on `&` (and on the first `=` of each pair)
**before** any decoding takes place. Each key and value is then strictly
percent-decoded:

- A literal `%` must always be followed by two hexadecimal digits. An
  isolated `%` (or a `%` followed by a non-hex digit) is rejected.
- The decoded byte sequence must be valid UTF-8. Overlong encodings,
  stray continuation bytes, truncated sequences, and invalid lead bytes
  are rejected.
- `+` is decoded as a space, per the
  `application/x-www-form-urlencoded` rules.
- Every key must be unique **after decoding**. Two raw keys that decode
  to the same name (for example `a` and `%61`) are reported as duplicates.
- Bracket-style keys such as `a[b]` are kept as literal keys. They never
  produce nested objects or arrays.
- Special names such as `__proto__`, `constructor`, and `prototype` are
  stored as ordinary data. The snapshot has a `null` prototype, so they
  cannot pollute `Object.prototype`.
- The snapshot is frozen: its properties cannot be added, changed, or
  deleted.
- When the URL has no query string, `req.strictQuery` is a shared,
  frozen, empty snapshot.

Any failure is reported with a `400` error that is passed to the error
handler before the downstream handler is invoked. Error positions are
always raw offsets into the original query string, never offsets into the
decoded string.

## Errors

All errors have `status`/`statusCode` set to `400` and one of the
following `code` values:

| code | meaning | extra properties |
| --- | --- | --- |
| `STRICT_QUERY_INVALID_ENCODING` | a `%` is not followed by two hex digits | `position` — raw offset of the `%` |
| `STRICT_QUERY_INVALID_UTF8` | the percent-decoded bytes are not valid UTF-8 | `position` — raw offset where the sequence starts |
| `STRICT_QUERY_DUPLICATE` | two raw keys decode to the same name | `key` — the decoded name; `positions` — raw offsets of both keys |

For example, `?a=1&%61=2` produces:

```
duplicate query parameter "a" at positions 0 and 4
```

and `?x=1&%61=2&a=3` reports positions `4` and `10` — offsets into the
raw query string, not into any decoded representation.

## Relationship with `req.query`

`req.strictQuery` is independent of `req.query`. The default query
parser (controlled by the `query parser` setting) keeps parsing
`req.query` exactly as it did before: bracket keys stay literal and
duplicate keys become arrays. The strict middleware does not change,
replace, or disable it.

```js
app.use(express.strictQuery());

// GET /?a%5Bb%5D=1&a=1&a=2
app.get('/', function (req, res) {
  // req.query       -> { 'a[b]': '1', a: ['1', '2'] }
  // req.strictQuery -> 400: duplicate key "a" (handler not called)
});
```
