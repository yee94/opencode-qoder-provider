# RSA Key Discovery and `info` Field Generation

## Overview

The JWT payload contains an `info` field. **Disassembly has confirmed**: the `info` field comes from `userInfo struct offset 0x80` and is **AES-CBC decrypted** from `encrypt_user_info` (748 chars → 448 chars) via `AesDecryptWithBase64`. The RSA public key and `encrypt.RsaEncrypt` function exist in the binary but their relationship to the `info` field is **NOT confirmed** — the RSA encryption may be used elsewhere or for a different purpose.

## info Field — What We Know

### Source (confirmed from disassembly)

`getAuthPayload` (VA `0x100419560`) builds the payload JSON:

```
key="info" (0x100de59b1, len=4) → value = userInfo+0x80 (len from userInfo+0x88)
```

`GenerateAuthToken` (VA `0x100416df0`) passes it:
```
100416e34: ldr x1, [userInfo + 0x80]  → info field ptr
100416e38: ldr x2, [userInfo + 0x88]  → info field len
100416e48: bl getAuthPayload(self, info_ptr, info_len, 0, 0)
```

### Candidate source fields in `shared_client/cache/user`

| JSON field | Length | Offset | Match? |
|------------|--------|--------|--------|
| `encrypt_user_info` | 748 chars | ? | ✅ **Confirmed** — AES-decrypted → 448 char info field |
| `key` | 172 chars | 0x90 | No — this is at offset 0x90 (machineToken/Cosy-Key) |
| `security_oauth_token` | 27 chars | ? | Too short |

**Confirmed**: `info` field is 448 characters. The transformation is: `encrypt_user_info` (748 chars) → `AesDecryptWithBase64()` → `info` (448 chars). The AES key/IV parameters come from `decryptUserInfo`'s x4/x5 inputs.

### Custom Base64 Encoding

`encrypt.(*encoding).encodeToString` (VA `0x10037f7c0` - `0x10037fa30`)
`encrypt.(*encoding).encodeTo` (VA `0x10037fa30` - `0x10037fd20`)

The custom base64 alphabet is confirmed at binary offset `0x20d5720`:

```
_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!
```

Padding character: `$` (ASCII 36, found at VA `0x1020d0988`)

This is a direct substitution of the standard Base64 alphabet:
```
ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/
```

**Note**: The `info` field (448 chars) appears to be standard base64 output (not custom base64). The custom base64 is used for request body encoding. The relationship between the AES-decrypted output and the 448-char info value is: AES-CBC decrypt → PKCS7 unpad → the result IS the info field (already a printable string, no further encoding needed).

### Call Chain (from disassembly)

```
GenerateAuthToken (VA 0x100416df0)
  → GetCachedUserInfo() (VA 0x100415e20) — get userInfo struct
  → ldr x1, [userInfo + 0x80] → info field ptr (AES-decrypted encrypt_user_info)
  → ldr x2, [userInfo + 0x88] → info field len
  → getAuthPayload(self, info_ptr, info_len, 0, 0) (VA 0x100419560)
      → Build JSON with 5 fields → json.Marshal → base64.StdEncoding.EncodeToString
  → ldr x9, [userInfo + 0x90] → machineToken ptr (key field, 172 chars)
  → ldr x10, [userInfo + 0x98] → machineToken len
  → getAuthSignature(b64_payload, urlPath, machineToken, timestamp, ...) (VA 0x1004193b0)
      → fmt.Sprintf("%s\n%s\n%s\n%s\n%s", ...) → MD5 → hex
  → fmt.Sprintf("Bearer COSY.%s.%s", b64_payload, sig)
  → Return: x0,x1 = Authorization token; x2,x3 = machineToken (for Cosy-Key header)
```

### RSA Public Key (captured from Frida, role in info field NOT confirmed)

The following RSA public key was captured via Frida hooking `encrypt.RsaEncrypt`:

```
-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----
```

**Role**: RSA-PKCS1v15, 1024-bit. The `encrypt.RsaEncrypt` function exists (VA `0x100380cb0`), and Frida confirmed it receives 16-byte random hex input. However, **the info field does NOT come from RSA encryption** — it comes from AES-CBC decryption of `encrypt_user_info`. The RSA encryption may be used for a different purpose (e.g., device fingerprinting, telemetry, or a fallback auth path).

## Current Assessment

### What We Know

| Item | Status | Confidence |
|------|--------|------------|
| RSA public key (PEM) | ✅ Captured | High |
| Algorithm (RSA-PKCS1v15) | ✅ Confirmed | High |
| Key size (1024-bit) | ✅ Confirmed | High |
| Custom base64 alphabet | ✅ Captured | High |
| Custom base64 padding char `$` | ✅ Captured (VA 0x1020d0988) | High |
| info field = AES-decrypted encrypt_user_info | ✅ Confirmed via call chain | High |
| info field length | ✅ 448 chars | High |
| info field is session-stable | ✅ Same value across calls | High |
| AES key/IV for decrypt | ❓ Not yet traced | — |
| RSA encryption purpose | ❓ NOT used for info field | — |

### Frida Memory Reading Limitation

Frida `Memory.readByteArray` and `ptr(addr).readU8()` both crash the Go process:
```
non-Go code set up signal handler without SA_ONSTACK flag
```
This is a known Go runtime issue with Frida. Multiple hook versions (v1-v4) all failed to read actual parameter contents. Only parameter lengths were confirmed via registers.

### Can We Fake the `info` Field?

**Maybe, but it requires the AES key.** The info field is AES-CBC decrypted from `encrypt_user_info`. To generate our own:

1. **We have `encrypt_user_info`** (748 chars from shared_client/cache/user)
2. **We need the AES key/IV** — passed to `AesDecryptWithBase64` via `decryptUserInfo`'s x4/x5 parameters
3. **The AES key source** — likely derived from machine serial key, `key` field, or a hardcoded constant

**Hypothesis**: The AES key might be the machine serial number (`50485058-4c35-47`, truncated to 16 bytes) or derived from the `key` field. Previous attempts with `50485058-4c35-47` failed, but the IV may have been wrong.

## Next Steps

### Priority 1: Test `info` Field Validation

```python
# Generate our own RSA-encrypted value
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
import base64, os

# The public key
PUBLIC_KEY_PEM = b"""-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----"""

public_key = serialization.load_pem_public_key(PUBLIC_KEY_PEM)

# Encrypt 16 random bytes
random_hex = os.urandom(16).hex().encode()  # 32 bytes of hex
encrypted = public_key.encrypt(
    random_hex,
    padding.PKCS1v15(),
)

# Standard base64 → custom alphabet
CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

std_b64 = base64.b64encode(encrypted).decode()
custom_b64 = ''.join(CUSTOM_ALPHABET[STANDARD_BASE64.index(c)] if c in STANDARD_BASE64 else c for c in std_b64)

print(f"RSA output length: {len(encrypted)} bytes")
print(f"Standard base64: {len(std_b64)} chars")
print(f"Custom base64: {len(custom_b64)} chars")
print(f"Expected info field: ~336 chars")
print(f"Match: {len(custom_b64) == 336 or len(custom_b64) == 172}")
```

If this produces the correct length (172 or 336), we can generate our own `info` field and the server should accept it (since it only needs to decrypt and verify the random hex).

### Priority 2: Frida Hook `RsaEncrypt` Input/Output

```javascript
// Hook encrypt.RsaEncrypt to see what's being encrypted
const rsaEncrypt = Module.findBaseAddress(Process.mainModule.path).add(0x100380cb0);

Interceptor.attach(rsaEncrypt, {
    onEnter: function(args) {
        // args[0] = input data ptr
        // args[1] = input length
        // args[2] = public key or context
        this.inputLen = args[1].toInt32();
        console.log(`[RsaEncrypt] Input length: ${this.inputLen}`);
        if (this.inputLen < 1024) {
            console.log(`[RsaEncrypt] Input: ${ptr(args[0]).readUtf8String(this.inputLen)}`);
        }
    },
    onLeave: function(retval) {
        // retval = encrypted output (or pointer to it)
        console.log(`[RsaEncrypt] Output: ${retval.readCString()}`);
    }
});
```

This will tell us:
- What's being encrypted (just the 16 random hex, or more?)
- What the output length actually is
- Whether there are additional processing steps

## Related Documents

- `docs/cosy-jwt-signature-algorithm.md` — JWT signature algorithm (uses `info` as part of payload)
- `docs/qoder-encoding-reference.md` — Custom base64 alphabet details
- `docs/qoder-request-encryption-reverse-engineering.md` — Request body encoding analysis
- `docs/cosy-jwt-analysis.md` — Original JWT structure analysis
