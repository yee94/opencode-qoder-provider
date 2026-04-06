# HTTP Signature Headers

## Overview

Qoder CLI sends **two independent signatures** with each API request:

1. **JWT Signature** (`Authorization` header) — user/session authentication
2. **HTTP Signature** (`Signature` header) — request integrity check

This document covers the HTTP Signature, which is **completely separate** from the JWT signature. See `docs/cosy-jwt-signature-algorithm.md` for the JWT details.

## Headers Set by `addBigModelSignatureHeaders`

Function VA: `0x100422b70` - `0x100422eb0`

### `Date` Header

```
Date: Mon, 02 Jan 2006 15:04:05 GMT
```

- Format: RFC 1123 (Go's `time.RFC1123` template)
- Value: Current time at request construction
- Used as input to the `Signature` header calculation

### `Signature` Header

```
Signature: <32-char-lowercase-hex>
```

Algorithm:
```
signature = MD5("cosy" + "&" + "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==" + "&" + <Date_header_value>)
```

Breaking it down:
```
input = "cosy&d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==&Mon, 02 Jan 2006 15:04:05 GMT"
signature = MD5(input)  →  32-char hex
```

The secret `"d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw=="` is the Base64 encoding of:
```
war, war never changes
```

This is a static string embedded in the binary — likely a developer easter egg (Fallout game reference).

### `Appcode` Header

```
Appcode: sign
```

- Fixed value: `"sign"`
- Purpose: Tells the API gateway to validate the `Signature` header

## Complete Example

```http
POST /algo/api/v2/service/pro/sse/agent_chat_generation HTTP/1.1
Host: api3.qoder.sh
Date: Mon, 06 Apr 2026 04:00:00 GMT
Signature: a1b2c3d4e5f6...  (MD5 of "cosy&d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==&Mon, 06 Apr 2026 04:00:00 GMT")
Appcode: sign
Authorization: Bearer COSY.<payload>.<sig>
Cosy-User: 019cfa7a-03f2-7998-9aac-fb3f82554742
Cosy-Date: 1775448000
Cosy-Key: I+Wvx6x7shV2aJRZ...
...
```

## Key Properties

| Property | Value |
|----------|-------|
| Algorithm | MD5 (standard `crypto/md5`) |
| Secret | Static string `"war, war never changes"` (Base64: `d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==`) |
| Time-binding | Date header (changes every request) |
| Output | 32-char lowercase hex |
| Purpose | Request integrity + anti-replay |

## Implementation (Python)

```python
import hashlib
import email.utils

def build_http_signature_headers() -> dict:
    """
    Build the HTTP Signature headers for Qoder API.
    
    Returns:
        Dict with 'Date', 'Signature', and 'Appcode' headers.
    """
    # Date in RFC 1123 format
    date_str = email.utils.formatdate(timeval=None, localtime=False, usegmt=True)
    # Go uses "Mon, 02 Jan 2006 15:04:05 GMT" format
    # Python's email.utils.formatdate produces: "Mon, 06 Apr 2026 04:00:00 GMT"
    
    # Signature
    secret = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw=="
    sig_input = f"cosy&{secret}&{date_str}"
    sig = hashlib.md5(sig_input.encode()).hexdigest()
    
    return {
        "Date": date_str,
        "Signature": sig,
        "Appcode": "sign",
    }

# Example:
headers = build_http_signature_headers()
print(headers)
# {
#   'Date': 'Mon, 06 Apr 2026 04:00:00 GMT',
#   'Signature': 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
#   'Appcode': 'sign',
# }
```

## Implementation (TypeScript/Node.js)

```typescript
import { createHash } from 'crypto';

function buildHttpSignatureHeaders(): Record<string, string> {
    // Date in RFC 1123 format
    const dateStr = new Date().toUTCString();
    // Node's Date.prototype.toUTCString() produces RFC 1123: "Mon, 06 Apr 2026 04:00:00 GMT"

    const secret = 'd2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==';
    const sigInput = `cosy&${secret}&${dateStr}`;
    const sig = createHash('md5').update(sigInput).digest('hex');

    return {
        'Date': dateStr,
        'Signature': sig,
        'Appcode': 'sign',
    };
}
```

## Relationship to JWT Signature

| Aspect | JWT Signature | HTTP Signature |
|--------|---------------|----------------|
| Header | `Authorization` | `Signature` |
| Input | payload_b64 + machineToken + timestamp + body_hash + url_path | `"cosy" + "&" + secret + "&" + Date` |
| Secret | `machineToken` (user-specific, 172 bytes) | Static string (all users share) |
| Purpose | User authentication | Request integrity |
| Time-binding | `Cosy-Date` (unix timestamp) | `Date` (RFC 1123) |
| Both MD5? | ✅ Yes | ✅ Yes |

**Both must be correct** for the server to accept the request. The HTTP Signature is simpler (static secret) but still time-bound via the Date header.

## Binary Analysis

The `addBigModelSignatureHeaders` function constructs these headers as part of the same call chain as the JWT headers:

```
HTTP request builder
  → addBigModelSignatureHeaders (VA 0x100422b70)
      → time.Now().UTC().Format(time.RFC1123)  → Date header
      → MD5("cosy&d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==&" + date)  → Signature header
      → "sign"  → Appcode header
  → addBigModelAuthorizationHeaders (VA 0x100422eb0)
      → JWT + Cosy-* headers
```

Both are called before the HTTP request is sent.

## Related Documents

- `docs/cosy-jwt-signature-algorithm.md` — JWT signature (Authorization header)
- `docs/standalone-api-call.md` — Complete API request construction
- `docs/reverse-engineering-jwt-signature.md` — JWT signature reverse engineering
