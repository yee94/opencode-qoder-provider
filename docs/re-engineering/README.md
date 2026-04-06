# Reverse Engineering Artifacts

Supporting data for Qoder CLI reverse engineering. All conclusions are in `docs/*.md`.

## Structure

```
docs/re-engineering/
├── captured-data/
│   ├── qoder_request_3.bin    # Custom base64 encoded request body (key reference)
│   ├── qoder_request_4.bin    # Stream JSON request format
│   └── qoder_headers_3.json   # Headers from request 3
├── disassembly/
│   ├── disasm_addBigModelSigHeaders.txt     # addBigModelSignatureHeaders (0x100422b70)
│   ├── disasm_addBigModelAuthHeaders.txt    # addBigModelAuthorizationHeaders (0x100422eb0)
│   ├── disasm_getAuthSignature.txt          # getAuthSignature (0x1004193b0)
│   ├── disasm_getAuthPayload.txt            # getAuthPayload (0x100419560)
│   ├── disasm_Md5Encode.txt                 # encrypt.Md5Encode (0x100380f70)
│   └── disasm_GenerateAuthToken.txt         # GenerateAuthToken (0x100416df0)
└── frida-scripts/
    ├── frida-encrypt-hook-v5.js   # ✅ Successful: Md5Encode + SigHeaders hook
    └── frida-hook-http.js         # HTTP request interception reference
```

## What Was Kept

Only files that provide reference for **future work** on unresolved items:

| Item | Status | Reference |
|------|--------|-----------|
| JWT sig algorithm | ✅ Done | `../cosy-jwt-signature-algorithm.md` |
| HTTP Signature header | ✅ Done | `../http-signature-headers.md` |
| Custom base64 alphabet + padding `$` | ✅ Done | `../custom-base64-encoding.md` |
| RSA public key (1024-bit) | ✅ Captured | `../rsa-key-discovery.md` |
| Auth file decryption (AES-128-CBC) | ✅ Done | `../qodercli-auth-decryption.md` |
| DYLD injection | ✅ Done | `../frida-analysis.md` (路径 F) |

## What Was Removed

All obsolete iterations: 21 Frida scripts (v1-v4 crashes, sg/UMID hooks that proved irrelevant), duplicate binary captures, GoReSym 10MB output, and the decoder tool (logic already documented in `custom-base64-encoding.md`).

## Remaining Unknowns

See `../rsa-key-discovery.md` — the 128→252 byte transformation between RSA output and custom base64 input.
