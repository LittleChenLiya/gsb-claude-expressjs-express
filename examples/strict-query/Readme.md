# Strict query parsing

Demonstrates the `express.strictQuery` middleware, an opt-in, strict
parser for the URL query component. Unlike the built-in `req.query`
getter (which keeps its default `"simple"` behavior), this middleware
places its result on a separate request property, `req.strictQuery`, and
rejects ambiguous or malformed input before the handler runs.

## Rules

- The query component is split on `&` exactly as it appears in the
  original URL.
- Keys and values are strictly percent-decoded byte by byte and then
  validated as UTF-8.
- A stray `%` / non-hex escape and invalid UTF-8 are different errors
  (`MALFORMED_PERCENT_ENCODING` and `INVALID_UTF8`), each reported with
  the **raw** character offset in the query string (never the
  post-decode offset).
- `+` is decoded as a space, following the explicit
  `application/x-www-form-urlencoded` form rule. Pass
  `{ plus: 'keep' }` to leave `+` untouched.
- Bracket keys such as `a[b]` remain literal keys; no arrays or nested
  objects are produced.
- Duplicate keys are rejected after percent-decoding, so `a` and `%61`
  are detected as the same key. The error reports the raw positions of
  both occurrences.
- `__proto__`, `constructor` and similar names are stored as ordinary,
  non-writable data on a null-prototype object and cannot modify any
  object prototype.
- With no query component, an empty, frozen, null-prototype snapshot is
  returned. The same snapshot is shared across requests.

## Run

```sh
node examples/strict-query
```

Then, for example:

```sh
curl -i "http://localhost:3000/?a=1&%61=2"
# HTTP/1.1 400 Bad Request
# Duplicate query parameter "a" at positions 0 and 4

curl -s "http://localhost:3000/?a%5Bb%5D=1"
# {"query":{"a[b]":"1"},"strictQuery":{"a[b]":"1"}}

curl -s "http://localhost:3000/?__proto__=evil"
# {"query":{"__proto__":"evil"},"strictQuery":{"__proto__":"evil"}}
```

## Built-in httptest-style self-check

The example can also run a self-check that starts the application on an
ephemeral port, issues real HTTP requests and prints PASS/FAIL for each
case:

```sh
node examples/strict-query --selftest
```

