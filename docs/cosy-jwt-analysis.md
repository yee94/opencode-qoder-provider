# COSY JWT 认证机制分析

## 概述

Qoder API 使用自定义的 JWT 格式进行认证，前缀为 `COSY` 而非标准的 `Bearer`。该 JWT 与每个请求绑定，包含 `requestId` 字段，服务器据此检测重复请求。

## JWT 结构

### 格式

```
COSY.{base64_payload}.{signature}
```

完整示例：
```
COSY.eyJjb3N5VmVyc2lvbiI6IjAuMS4zOCIsImlkZVZlcnNpb24iOiIiLCJpbmZvIjoieWdxU2s2RTlZZEtTWWoxaWhKSTg5MTRZNnA2ekw0aWF6bFl4L0pRWWRJZUxoRU5mN0htbXJWQUhacWQ5SWtJSzVaSUtMNG42TmhUSWh4bjM3THN1ZEphcWVRTDFYUjJNYlRVTk14a1gwUkRWeUdEc2Z6K3BBZnJxM245YkZKeXpIMGF3NTJUZFgrTml3SWtNZFRxZnNoY2o1dm1XdytESXM0Q2hQNUhETlRtUDAzV09oNzA3OFIzS2pzOEZrSXdPbk43emZEYzltV1ZMOHY4cXA2Zm9GZGVzTWxkd0dvTU1xTHFkR1JUR25RVzc4MGlxNVUwMnBjUlNYa3drMVlxZUJQSjZzR2YyTnFpdVVnV1lCanhyN1d1bCtHdXFCWWxBM2tTSFJyQTI1SytlenRJUzVQanI4Mkk2MmVJdGJVeXNDbStKQUhrTWJtOVprWmowdlFRUjIvbmsxVkRrd2g0WUtQZXVxT0YwbnRKUjcvN2VqcFFhZDRZS2xZRm9MOCs0SXQvVWdMR3F0a1lSamMvQWl4SnBoK2JyYmYvZW01YUp3OWk3TUdNSVN6clVSZHpSSHZGSjdVWFRLQ0tBbWVxNyIsInJlcXVlc3RJZCI6ImYwNWUyYmViLTY0YjEtNGM4NC1hYzYxLTIyMzYzZDI1MmJiYSIsInZlcnNpb24iOiJ2MSJ9.06cec1f722a2900d8afe5d3097b8b256
```

### 组成部分

| 部分 | 内容 | 说明 |
|------|------|------|
| 前缀 | `COSY` | 固定字符串，标识认证类型 |
| Payload | Base64 编码的 JSON | 包含版本信息、请求 ID 和加密的 info 字段 |
| Signature | 32 字符十六进制 | 看起来是 MD5 哈希（16 字节） |

## Payload 结构

解码后的 JSON：

```json
{
  "cosyVersion": "0.1.38",
  "ideVersion": "",
  "info": "ygqSk6E9YdKSYj1ihJI8914Y6p6zL4iazlYx/JQYdIeLhENf7HmmrVAHZqd9IkIK5ZIKL4n6NhTIhxn37LsudJaqeQL1XR2MbTUNMxkX0RDVyGDsfz+pAfrq3n9bFJyzH0aw52TdX+NiwIkMdTqfshcj5vmWw+DIs4ChP5HDNTmP03WOh7078R3Kjs8FkIwOnN7zfDc9mWVL8v8qp6foFdesMldwGoMMqLqdGRTGnQW780iq5U02pcRSXkwk1YqeBPJ6sGf2NqiuUgWYBjxr7Wul+GuqBYlA3kSHRrA25K+eztIS5Pjr82I62eItbUysCm+JAHkMbm9ZkZj0vQQR2/nk1VDkwh4YKPeuqOF0ntJR7/7ejpQad4YKlYFoL8+4It/UgLGqtkYRjc/AixJph+brbf/em5aJw9i7MGMISzrURdzRHvFJ7UXTKCKAmeq7",
  "requestId": "f05e2beb-64b1-4c84-ac61-22363d252bba",
  "version": "v1"
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `cosyVersion` | string | 客户端版本，与 `Cosy-Version` 头一致 |
| `ideVersion` | string | IDE 版本，CLI 使用时为空 |
| `info` | string | 448 字符的加密数据，可能包含用户认证信息 |
| `requestId` | UUID | 请求唯一标识，**必须每次请求都不同** |
| `version` | string | JWT 格式版本，固定为 `v1` |

## 签名算法 — ✅ 已完全破解

**Status**: 签名算法已从 qodercli 二进制中完全逆向。详见 `docs/cosy-jwt-signature-algorithm.md`。

```
sig = MD5(base64_payload \n machineToken \n timestamp \n s4 \n url_path)
```

- 分隔符是 `\n`（换行符），不是 `&`
- `machineToken` 从 auth 文件解密获得（172 字节，即 `cosy_machinetoken` 字段）
- `timestamp` 是 10 位 Unix 时间戳字符串
- `s4` 对于 LLM API 调用为空字符串（第一次调用为 96 字节 body hash）
- `url_path` 是 API 路径（不含 query string）
- 使用标准 `crypto/md5`，**不需要 HMAC，不需要额外密钥**

签名生成函数: `getAuthSignature` (VA `0x1004193b0`)
MD5 实现: `encrypt.Md5Encode` (VA `0x100380f70`)

## 关键发现

### 1. requestId 是去重关键

**结论**: 服务器通过 JWT 中的 `requestId` 检测重复请求，而非请求体中的 `request_id`。

**证据**:
- 修改请求体中的 `request_id` 但使用相同的 JWT → 返回 "Duplicate request" (403)
- JWT 中的 `requestId` 与请求体中的 `request_id` 不同：
  - JWT: `f05e2beb-64b1-4c84-ac61-22363d252bba`
  - Body: `30a0819b-6f9b-42c1-9b04-fa00c0526571`

### 2. Info 字段分析

**特征**:
- 长度: ~336 字符（RSA-1024 加密输出 + 自定义 base64 编码）
- 生成过程: 16 字节随机 hex → RSA-PKCS1v15 加密 → 自定义 base64 编码
- RSA 公钥: 1024-bit，PEM 格式嵌入在二进制中（已捕获）

**生成函数链**:
1. `encrypt.RsaEncrypt` (VA `0x100380cb0`) — RSA 加密
2. `encrypt.(*encoding).encodeToString` (VA `0x10037f7c0`) — 自定义 base64
3. 自定义 base64 alphabet: `_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!`

**详见**: `docs/rsa-key-discovery.md`

### 3. 签名算法

**✅ 已完全逆向** — 见 `docs/cosy-jwt-signature-algorithm.md`

```
sig = MD5(base64_payload \n machineToken \n timestamp \n s4 \n url_path)
```

标准 MD5，无 HMAC，无隐藏密钥（除 machineToken 外）。

## 请求头要求

使用 JWT 时必须携带以下关键头：

| 头 | 示例值 | 说明 |
|---|--------|------|
| `Authorization` | `Bearer COSY.{payload}.{sig}` | 注意前缀是 `Bearer ` 然后才是 `COSY.` |
| `Cosy-Date` | `1775443578` | Unix 时间戳（秒） |
| `Cosy-Version` | `0.1.38` | 客户端版本 |
| `Cosy-User` | UUID | 用户标识 |
| `Cosy-Machineid` | UUID 格式 | 机器标识 |
| `Cosy-Machinetoken` | Base64 字符串 | 机器令牌 |

## 当前限制

### 已解决

| 问题 | 状态 | 解决文档 |
|------|------|----------|
| 签名算法 | ✅ 已破解 | `docs/cosy-jwt-signature-algorithm.md` |
| machineToken 来源 | ✅ 已解密 | `docs/qodercli-auth-decryption.md` |
| HTTP Signature 头 | ✅ 已破解 | `docs/http-signature-headers.md` |
| 全部必需 header | ✅ 已确认 | 见本文 "请求头要求" 章节 |

### 剩余未知

| 未知 | 影响 | 调查状态 |
|------|------|----------|
| `info` 字段能否伪造 | 中 — 决定能否完全独立生成 JWT | `docs/rsa-key-discovery.md` |
| `Cosy-Key` 生成机制 | 低 — 有缓存值可用 | 待调查 |
| `s4` 参数（96 字节 body hash） | 低 — LLM 调用时为空 | 已确认不需要 |

## 下一步逆向工程方向

签名算法已完全逆向，`info` 字段的 RSA 公钥已捕获。剩余工作见 `docs/rsa-key-discovery.md`。

## 相关文件

- 捕获的 headers: `/tmp/forward/headers.json`
- 捕获的请求体: `/tmp/forward/body.bin`
- 分析脚本: `scripts/analyze-cosy-jwt.js`
- 认证解密: `scripts/qoder-direct-api.js` (包含 auth 文件解密逻辑)

## 时间线

| 时间 | 事件 |
|------|------|
| 2026-04-06 10:46 | 捕获原始请求（JWT 时间戳: 1775443578） |
| 2026-04-06 11:00 | 确认 JWT 结构并解码 payload |
| 2026-04-06 11:05 | 发现 requestId 是去重关键字段 |
| 2026-04-06 11:10 | 尝试修改 JWT requestId → 超时/无响应 |
| 2026-04-06 12:00 | GoReSym 完成，找到全部函数地址 |
| 2026-04-06 12:30 | Frida hook 确认 getAuthSignature 参数映射 |
| 2026-04-06 12:45 | 签名算法完全逆向: `MD5(s1\ns2\ns3\ns4\ns5)` |
| 2026-04-06 13:00 | RSA 公钥捕获，info 字段生成链确认 |
