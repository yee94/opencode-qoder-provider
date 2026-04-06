# COSY JWT Signature Algorithm — Fully Reversed

## Status: ✅ COMPLETE

The JWT signature algorithm has been fully reverse-engineered from the `qodercli` binary using GoReSym + Frida dynamic analysis.

## Format

```
Authorization: Bearer COSY.{base64_payload}.{md5_sig}
```

- `base64_payload`: Standard Base64 encoding (`encoding/base64.StdEncoding`) of the payload JSON
- `md5_sig`: 32-character lowercase hex string (MD5, 128 bits)
- Format string in binary: `"Bearer COSY.%s.%s"` (found at VA `0x100e01d31`)

## Payload JSON Schema

```json
{
  "version": "v1",
  "requestId": "<uuid.NewString()>",
  "info": "<AES-decrypted from encrypt_user_info via AesDecryptWithBase64, 448 chars>",
  "cosyVersion": "0.1.38",
  "ideVersion": ""
}
```

Fields:
| Field | Source | Notes |
|-------|--------|-------|
| `version` | Hardcoded | Always `"v1"` |
| `requestId` | `github.com/google/uuid.NewString()` | New UUID each request |
| `info` | AES-CBC decrypted from `encrypt_user_info` (748→448 chars) via `AesDecryptWithBase64` at `userInfo+0x80` | 448 chars, session-stable (cached) |
| `cosyVersion` | Global variable | Matches `Cosy-Version` header |
| `ideVersion` | From caller param | Empty for qodercli |

Build function: `getAuthPayload` (VA `0x100419560`)

## Signature Algorithm

### Core Function

`getAuthSignature` (VA `0x1004193b0` - `0x100419560`)

```
sig = MD5(s1 \n s2 \n s3 \n s4 \n s5)
```

The separator is `\n` (newline, `0x0a`), **NOT** `&` as the `Md5Encode` helper's default behavior might suggest. When `getAuthSignature` calls this function, it passes a **single pre-formatted string** from `fmt.Sprintf("%s\n%s\n%s\n%s\n%s", s1, s2, s3, s4, s5)`, so `Md5Encode` just wraps it in a 1-element slice and joins (no-op for 1 element).

### Parameter Mapping

| Parameter | Register | Source | Typical Length | Description |
|-----------|----------|--------|----------------|-------------|
| `s1` | x1, x2 | `base64_payload` | 752 bytes | The Base64-encoded payload JSON |
| `s2` | x9, x10 | `machineToken` = `key` field | 172 bytes (0xac) | From `~/.qoder/shared_client/cache/user` JSON `key` field (NOT `cosy_machinetoken`) |
| `s3` | x7, x8 | `unix_timestamp` | 10 bytes | `fmt.Sprintf("%d", time.Now().Unix())` |
| `s4` | x5, x6 | Caller param | 96 or 0 bytes | First call: 96 bytes (likely body hash); subsequent: empty string |
| `s5` | x3, x4 | `url_path` | 18/28/85 bytes | URL path truncated before `?` (via `bytes.IndexByte(urlPath, '?')`) |

### Frida Hook Confirmation

| Call # | s1 len | s2 len | s3 len | s4 len | s5 len | API Context |
|--------|--------|--------|--------|--------|--------|-------------|
| 1 | 752 | 172 | 10 | 96 | 85 | Heartbeat / auth status |
| 2 | 752 | 172 | 10 | 0 | 28 | LLM API call |
| 3 | 752 | 172 | 10 | 0 | 18 | Another LLM endpoint |
| 4 | 752 | 172 | 10 | 0 | 18 | Another LLM endpoint |

- `s1=752` is consistent (payload doesn't change in size)
- `s2=172` is consistent (machineToken from auth cache)
- `s3=10` is consistent (10-digit Unix timestamp)
- `s4=96` for first call, `0` for subsequent — likely body hash for initial auth, empty for LLM calls
- `s5` varies by endpoint path length

### MD5 Implementation

`encrypt.Md5Encode` (VA `0x100380f70` - `0x100381140`)

Internal flow:
1. `strings.Join(slice, "&")` — separator is `&`, but caller passes 1 element so no-op
2. `runtime.stringtoslicebyte()` — converts string to `[]byte`
3. `crypto/md5.(*digest).Write()` — standard Go `crypto/md5`
4. `checkSum()` — finalizes the hash
5. Hex encoding via lookup table `"0123456789abcdef"` → 32-char lowercase hex

**This is standard MD5, not HMAC.** No secret key beyond the `machineToken` (which is already captured).

## Required Credentials

All values from decrypted auth files. **Two sources needed**:

### `~/.qoder/shared_client/cache/user` (active, has key field)

| Field | Value | Usage |
|-------|-------|-------|
| `uid` | `019cfa7a-03f2-7998-9aac-fb3f82554742` | `Cosy-User` header |
| `key` | `XMQcnCj6bMeE1YdYgBXG...` (172 chars) | `s2` in JWT sig, `Cosy-Key` header |
| `encrypt_user_info` | `xbHJzUMM2116Gl5MRQP...` (748 chars) | Source of `info` field (AES-decrypted → 448 chars) |

### `~/.qoder/.auth/user` (fallback, no key field)

| Field | Value | Usage |
|-------|-------|-------|
| `access_token` | `dt-GRros87PhONuxUwE75xCS01j` | OAuth token (not used in JWT sig) |
| `refresh_token` | `drt-5MBDsDXjzsYNVh4pflby1uYg` | Token refresh |

Note: `.qoder/.auth/user` does NOT contain `key` or `encrypt_user_info` fields. The active credentials are in `shared_client/cache/user`.

## HTTP Headers (Complete Set)

### Authorization (JWT) — `addBigModelAuthorizationHeaders` (VA `0x100422eb0`)

| Header | Value | Source |
|--------|-------|--------|
| `Cosy-User` | `<userId>` | `userInfo.vtable[0x48]` = `GetUserId()` |
| `Cosy-Date` | `<unix_timestamp>` | `fmt.Sprintf("%d", time.Now().Unix())` |
| `Cosy-Key` | `<machineToken>` | `GenerateAuthToken` return x2,x3 = `userInfo+0x90` = `key` field from `shared_client/cache/user` (NOT RSA-encrypted) |
| `Authorization` | `Bearer COSY.<b64_payload>.<md5_sig>` | `GenerateAuthToken` return x0,x1 |

**Key correction**: `Cosy-Key` is NOT an RSA-encrypted session key. It is the `key` field (172 chars) from `~/.qoder/shared_client/cache/user` — the same value used as `s2` (machineToken) in the JWT signature. Confirmed from `GenerateAuthToken` disassembly: after the call at `0x100423000: blr x7` (vtable[0x30] = `GenerateAuthToken`), x2,x3 hold the machineToken which is then set as the `Cosy-Key` header.

### HTTP Signature — `addBigModelSignatureHeaders` (VA `0x100422b70`)

| Header | Value |
|--------|-------|
| `Date` | RFC1123 format, e.g. `Mon, 02 Jan 2006 15:04:05 GMT` |
| `Signature` | `MD5("cosy" + "&" + "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==" + "&" + <Date_value>)` |
| `Appcode` | `sign` |

Note: `"d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw=="` = Base64 of `"war, war never changes"` (fallout reference)

**This is a completely separate signature from the JWT sig.** It's an HTTP-level integrity check.

## Complete Call Chain

```
addBigModelAuthorizationHeaders (VA 0x100422eb0)
  → GetAuthService() (VA 0x10041c410) — get auth config
  → time.Now() → fmt.Sprintf("%d", unix) → Cosy-Date
  → GenerateAuthToken (vtable+0x30) (VA 0x100416df0)
      → GetCachedUserInfo() (VA 0x100415e20) — get accessToken, machineToken
      → getAuthPayload(accessToken, ...) (VA 0x100419560)
          → Build JSON → json.Marshal → base64.StdEncoding.EncodeToString
      → getAuthSignature(b64_payload, urlPath, machineToken, timestamp, ...) (VA 0x1004193b0)
          → fmt.Sprintf("%s\n%s\n%s\n%s\n%s", ...) → MD5 → hex
      → fmt.Sprintf("Bearer COSY.%s.%s", b64_payload, sig)
```

## Full Header Set (Captured + Verified)

From mitmproxy + binary analysis:

| Header | Required? | Source |
|--------|-----------|--------|
| `Authorization` | ✅ | `Bearer COSY.{payload}.{sig}` |
| `Cosy-User` | ✅ | From auth file |
| `Cosy-Date` | ✅ | Unix timestamp (matches sig s3) |
| `Cosy-Key` | ✅ | RSA-encrypted session key |
| `Cosy-Version` | ✅ | `"0.1.38"` |
| `Cosy-Machineid` | ✅ | From auth file |
| `Cosy-Machinetoken` | ✅ | From auth file (s2 in sig) |
| `Date` | ✅ | RFC1123 format |
| `Signature` | ✅ | MD5 of `"cosy&<base64_fallout>&<Date>"` |
| `Appcode` | ✅ | `"sign"` |
| `accept` | ✅ | `"text/event-stream"` |
| `content-type` | ✅ | `"application/json"` |
| `cosy-clienttype` | ✅ | `"5"` |
| `login-version` | ✅ | `"v2"` |
| `cosy-data-policy` | ✅ | `"DISAGREE"` |
| `cosy-codebase-status` | ✅ | `"STILLA_DISABLED"` |
| `x-model-key` | ✅ | Model key (e.g. `"efficient"`) |
| `x-model-source` | ✅ | `"system"` |

## Key Findings vs Previous Assumptions

### What Was Wrong Before

| Previous Assumption | Actual Finding | Evidence |
|---------------------|----------------|----------|
| Signature uses HMAC or secret key | Standard MD5, no secret beyond machineToken | `Md5Encode` uses `crypto/md5` directly |
| `cosy-key` is the signing key | `cosy-key` = `key` field from auth cache = machineToken (s2 in sig) | `GenerateAuthToken` return x2,x3 = `userInfo+0x90` |
| `info` field is RSA-encrypted random hex | `info` is AES-CBC decrypted from `encrypt_user_info` (748→448 chars) | `decryptUserInfo → AesDecryptWithBase64` call chain |
| Need to reverse a complex algorithm | Algorithm is simple `MD5(s1\ns2\ns3\ns4\ns5)` | GoReSym + Frida register mapping |

### Remaining Unknowns

| Unknown | Impact | Investigation Needed |
|---------|--------|---------------------|
| `info` field AES key/IV | **High** — needed to regenerate info if it expires | `AesDecryptWithBase64` key param from `decryptUserInfo` x4/x5 — needs tracing back to `parseUserInfoFromStorage` |
| `s4` parameter (96-byte body hash on first call) | Low — s4=0 for LLM calls | Likely request body hash; empty for chat API |
| Custom base64 encoding table location in binary | Low — alphabet already captured | Need to locate in `encrypt.init` (VA `0x10037f620`) |

## Implementation Reference (Python)

```python
import hashlib
import base64
import json
import time
import uuid

def build_jwt_sig(payload_json: dict, machine_token: str, url_path: str) -> str:
    """
    Generate the COSY JWT signature.
    
    Args:
        payload_json: The JWT payload dict (will be JSON-serialized + base64 encoded)
        machine_token: From decrypted auth file (`key` field from shared_client/cache/user, 172 chars)
        url_path: API path without query params, e.g. "/algo/api/v2/service/pro/sse/agent_chat_generation"
    
    Returns:
        Complete Authorization header value (without "Bearer " prefix)
    """
    # 1. Build payload
    payload = json.dumps(payload_json, separators=(',', ':'))
    b64_payload = base64.b64encode(payload.encode()).decode()
    
    # 2. Timestamp
    timestamp = str(int(time.time()))
    
    # 3. s4 is empty for LLM calls (confirmed by Frida)
    s4 = ""
    
    # 4. Signature
    sig_input = f"{b64_payload}\n{machine_token}\n{timestamp}\n{s4}\n{url_path}"
    sig = hashlib.md5(sig_input.encode()).hexdigest()
    
    # 5. Full token
    return f"Bearer COSY.{b64_payload}.{sig}"

# Example usage:
machine_token = "P1gATgF2Esttw0GiS_RWQtskrohEnwZJ5XQo7KN-b35wSXkAZfOtZd9qUmem9k5sQecgFmqu_bFstKJcE7BfWJ-j"
url_path = "/algo/api/v2/service/pro/sse/agent_chat_generation"

payload = {
    "version": "v1",
    "requestId": str(uuid.uuid4()),
    "info": "<RSA-encrypted-value>",  # TODO: see rsa-key-discovery.md
    "cosyVersion": "0.1.38",
    "ideVersion": "",
}

auth_header = build_jwt_sig(payload, machine_token, url_path)
print(auth_header)
```

## Binary Function Reference

| Function | VA Range | Purpose |
|----------|----------|---------|
| `encrypt.Md5Encode` | `0x100380f70` - `0x100381140` | MD5 + hex encoding |
| `encrypt.RsaEncrypt` | `0x100380cb0` - `0x100380e70` | RSA-PKCS1v15 encryption (role in info field NOT confirmed) |
| `encrypt.AesEncryptWithBase64` | `0x1003809d0` - `0x100380b30` | AES encryption |
| `encrypt.AesDecryptWithBase64` | `0x100380b30` - `0x100380cb0` | AES decryption (decrypts `encrypt_user_info` → `info` field) |
| `encrypt.(*encoding).encodeToString` | `0x10037f7c0` - `0x10037fa30` | Custom base64 encoding (info field output?) |
| `getAuthSignature` | `0x1004193b0` - `0x100419560` | **JWT sig generation** |
| `getAuthPayload` | `0x100419560` - `0x100419790` | Payload JSON builder |
| `GenerateAuthToken` | `0x100416df0` - `0x100416f50` | Top-level auth token generation |
| `GetCachedUserInfo` | `0x100415e20` - `0x100415f10` | Read cached credentials |
| `GetAuthService` | `0x10041c410` - `0x10041c480` | Get auth service singleton |
| `addBigModelSignatureHeaders` | `0x100422b70` - `0x100422eb0` | Set Date/Signature/Appcode headers |
| `addBigModelAuthorizationHeaders` | `0x100422eb0` - `0x1004233a0` | Set JWT + Cosy-* headers |

## Related Documents

- `docs/http-signature-headers.md` — HTTP Signature/Appcode header details
- `docs/rsa-key-discovery.md` — RSA public key and `info` field generation
- `docs/qodercli-auth-decryption.md` — Auth file decryption
- `docs/qoder-encoding-reference.md` — Custom base64 alphabet
- `docs/frida-analysis.md` — Frida hook methodology and DYLD injection
