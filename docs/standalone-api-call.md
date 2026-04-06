# 独立 LLM API 调用 - 完整分析

## 概述

本文档记录实现不依赖 SDK 的独立 LLM API 调用的所有尝试和发现。

## 核心问题

要实现独立 API 调用，需要解决三个关键问题：

1. **请求体格式**: 服务器接受什么格式的请求体？
2. **认证机制**: 如何生成有效的 Authorization 头？
3. **签名算法**: 如何生成不被判定为"重复请求"的 JWT？

## 已确认的事实

### API 端点

```
POST https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation
```

查询参数（可选）：
- `FetchKeys=llm_model_result`
- `AgentId=agent_common`
- `Encode=1`

### 请求体编码

**结论**: 服务器接受**纯 JSON**，不需要自定义 base64 编码。

**证据**:
- 发送纯 JSON 返回 HTTP 200
- 自定义 base64 编码是 qodercli 的客户端行为，非服务端强制要求
- 其他 agent 的文档确认编码只是字符替换，非真正加密

**参考**: `docs/qoder-request-encryption-reverse-engineering.md`

### 请求体结构

服务器接受的完整 JSON 结构：

```json
{
  "request_id": "<UUID>",
  "request_set_id": "<UUID>",
  "chat_record_id": "<UUID>",
  "stream": true,
  "chat_task": "FREE_INPUT",
  "chat_context": {
    "chatPrompt": "",
    "extra": {
      "context": [],
      "modelConfig": {
        "is_reasoning": false,
        "key": "q35model_preview"
      }
    },
    "features": [],
    "imageUrls": null,
    "text": {
      "type": "text",
      "text": "用户消息"
    }
  },
  "image_urls": null,
  "is_reply": true,
  "is_retry": false,
  "session_id": "<UUID>",
  "model_config": {
    "key": "q35model_preview",
    "display_name": "Qwen3.6-Plus-DogFooding",
    "model": "",
    "format": "openai",
    "is_vl": true,
    "is_reasoning": false,
    "api_key": "",
    "url": "",
    "source": "system",
    "max_input_tokens": 180000
  },
  "messages": [
    {
      "role": "user",
      "content": "用户消息",
      "contents": [
        { "type": "text", "text": "用户消息" }
      ],
      "response_meta": {
        "id": "",
        "usage": {
          "prompt_tokens": 0,
          "completion_tokens": 0,
          "total_tokens": 0,
          "completion_tokens_details": { "reasoning_tokens": 0 },
          "prompt_tokens_details": { "cached_tokens": 0 }
        }
      },
      "reasoning_content_signature": ""
    }
  ]
}
```

**简化版本**（早期格式，可能仍有效）:

```json
{
  "model": "efficient",
  "messages": [
    {
      "role": "user",
      "content": "用户消息"
    }
  ],
  "stream": true
}
```

### 认证机制 — ✅ 签名算法已完全逆向

#### JWT 结构

```
Authorization: Bearer COSY.{base64_payload}.{md5_signature}
```

Payload:
```json
{
  "version": "v1",
  "requestId": "<UUID>",
  "info": "<AES-decrypted from encrypt_user_info, 448 chars>",
  "cosyVersion": "0.1.38",
  "ideVersion": ""
}
```

#### 签名算法（完全破解）

```
sig = MD5(base64_payload \n machineToken \n timestamp \n s4 \n url_path)
```

- `machineToken`: `key` field from `~/.qoder/shared_client/cache/user` (172 chars, NOT cosy_machinetoken)
- `s4`: LLM 调用时为空字符串（不需要 body hash）
- 标准 `crypto/md5`，无 HMAC

详见 `docs/cosy-jwt-signature-algorithm.md`

#### HTTP Signature（独立签名）

```
Signature = MD5("cosy&d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==&<Date_RFC1123>")
Appcode: sign
```

详见 `docs/http-signature-headers.md`

#### 必需的 HTTP 头

| 头 | 示例 | 说明 |
|---|------|------|
| `Authorization` | `Bearer COSY.{jwt}` | JWT 认证令牌 |
| `Cosy-Key` | 172 字符 Base64 | `key` 字段从 shared_client/cache/user (同 machineToken) |
| `Cosy-Date` | `1775443578` | Unix 时间戳（秒） |
| `Cosy-Version` | `0.1.38` | 客户端版本 |
| `Cosy-User` | UUID | 用户标识 |
| `Cosy-Machineid` | UUID | 机器标识（从序列号派生） |
| `Cosy-Machinetoken` | Base64 | 机器令牌 |
| `Cosy-Clienttype` | `5` | 客户端类型 |
| `X-Model-Key` | `q35model_preview` | 模型标识 |
| `X-Model-Source` | `system` | 模型来源 |

## 测试记录

### 测试 1: 纯 JSON 请求体

**日期**: 2026-04-06 11:00

**操作**: 发送纯 JSON（无自定义 base64 编码，无二进制头）

**结果**: ✅ HTTP 200

**结论**: 服务器接受纯 JSON

### 测试 2: 重用捕获的 JWT

**日期**: 2026-04-06 11:05

**操作**: 使用捕获的完整请求（包括原始 JWT）

**结果**: ❌ 403 "Duplicate request"

**原因**: JWT 中的 `requestId` 已被服务器记录

### 测试 3: 修改 JWT 中的 requestId

**日期**: 2026-04-06 11:10

**操作**: 修改 JWT payload 中的 `requestId`，保持原签名

**结果**: ❌ 请求超时/无响应

**原因**: 签名验证失败（签名与 payload 不匹配）

### 测试 4: 签名算法逆向（成功）

**日期**: 2026-04-06 12:00

**操作**: GoReSym 分析 + Frida hook 确认 `getAuthSignature` 参数映射

**结果**: ✅ **签名算法完全破解**

```
sig = MD5(base64_payload \n machineToken \n timestamp \n s4 \n url_path)
```

详见 `docs/cosy-jwt-signature-algorithm.md`

### cosy-key 分析

`cosy-key` 是 `key` 字段（172 字符），从 `~/.qoder/shared_client/cache/user` 解密获得。它**同时用于**：
1. `Cosy-Key` HTTP header
2. JWT sig 的 `s2` 参数（machineToken）

两者是同一个值，从 `GenerateAuthToken` 返回值 x2,x3 确认。该值来自 `userInfo struct offset 0x90`。

**重要纠正**: 之前文档 `docs/cosy-key-header-analysis.md` 错误地将 `bl 0x10036f1d0`（`zap.SugaredLogger.log` 日志调用）当作 Cosy-Key 生成函数。实际上 Cosy-Key 来自 `GenerateAuthToken` 的返回值 x2,x3 = machineToken。

详见 `docs/cosy-jwt-signature-algorithm.md`。

## 下一步行动

### 优先级 1: 用已捕获的 info 值测试 API 直连

info 字段是 session-stable 的（两次 Frida 调用相同值、相同指针）。可以直接使用已捕获的 info 值构建完整 JWT 并测试 API 请求。如果成功，说明服务端接受缓存的 info 值，不需要动态生成。

详见 `docs/rsa-key-discovery.md` 的 "Next Steps" 章节。

### 优先级 2: 确认 info 字段的 AES key（如果需要动态生成）

如果服务端发现 info 过期或失效，需要确认 `AesDecryptWithBase64` 使用的 AES key/IV：
- key 参数来自 `decryptUserInfo` 的 x4/x5 输入
- 追溯调用者 `parseUserInfoFromStorage` 或 `parseUserInfoByFile` 传入的值
- 或者用 Frida hook `AesDecryptWithBase64` 直接捕获 key/IV 参数

### 优先级 3: 更新 `qoder-direct-api.js`

用破解的签名算法替换现有的 fallback token 方式。

### 优先级 4: DYLD injection 方案完善

- 统一 C 源码和 Python 内置版本
- Intel Mac 编译兼容性
- 注入失败检测和 fallback

## 相关文档

- JWT 结构分析: `docs/cosy-jwt-analysis.md`
- JWT 签名逆向: `docs/reverse-engineering-jwt-signature.md`
- 请求体编码: `docs/qoder-request-encryption-reverse-engineering.md`
- Auth 文件解密: `docs/qodercli-auth-decryption.md`
- 编码快速参考: `docs/qoder-encoding-reference.md`
- Frida 分析: `docs/frida-analysis.md`

## 时间线

## 结论

**当前状态**: 
- ✅ 请求体格式已完全了解（纯 JSON，无需自定义编码）
- ✅ 所有必需的 HTTP 头已识别
- ✅ **JWT 签名算法已完全逆向** — `MD5(s1\ns2\ns3\ns4\ns5)`，标准 MD5
- ✅ HTTP Signature 已破解 — 静态 secret + Date MD5
- ⚠️ `info` 字段 RSA 公钥已捕获，伪造能力待验证

### 阻塞根因分析 — 已解除

JWT 签名算法已从二进制中完全逆向，不再阻塞。剩余唯一未知是 `info` 字段的 AES 密钥（`encrypt_user_info` → AES-CBC 解密 → info），详见 `docs/rsa-key-discovery.md`。info 字段是 session-stable 的（同一会话中值不变），如果服务端不强制验证其内容，可以直接复用已捕获的值。

### 可行的替代方案

#### 方案 A: DYLD injection（推荐 — 已验证可用）

**思路**: 使用 DYLD_INSERT_LIBRARIES 注入 dylib 替换 argv

1. 编译 20 行 C dylib
2. 通过环境变量注入消息
3. qodercli 自行处理签名和工具调用

**优点**: 
- 完全可用，已验证文本/工具/多模态
- 维护成本极低（20 行 C）
- 100% 确定性，无时序竞争

**缺点**:
- macOS only
- 无法控制工具执行
- 每次 fork 子进程

**详见**: `docs/frida-analysis.md` (路径 F)

#### 方案 B: 独立 API 直连（签名已破解，info 字段待验证）

**思路**: 用破解的签名算法直接构造 HTTP 请求

1. 从 auth 文件解密 credentials
2. 用 MD5 算法生成 JWT sig
3. 用静态 secret 生成 HTTP Signature
4. 直接 POST 到 API

**优点**:
- 跨平台
- 无子进程开销
- 高并发

**缺点**:
- `info` 字段能否伪造待验证
- 无法控制工具执行（服务端 agent loop）
- 上游签名格式变更需跟进

## 文档清单

| 文档 | 内容 | 状态 |
|------|------|------|
| `docs/cosy-jwt-analysis.md` | JWT 结构完整分析 | ✅ 完成（已更新） |
| `docs/cosy-jwt-signature-algorithm.md` | JWT 签名算法完整逆向 | ✅ 新建 |
| `docs/http-signature-headers.md` | HTTP Signature/Appcode headers | ✅ 新建 |
| `docs/rsa-key-discovery.md` | RSA 公钥和 info 字段生成 | ✅ 新建 |
| `docs/reverse-engineering-jwt-signature.md` | JWT 签名逆向工程 | ✅ 完成（已更新） |
| `docs/standalone-api-call.md` | 独立 API 调用完整分析 | ✅ 完成（已更新） |
| `docs/qoder-request-encryption-reverse-engineering.md` | 请求体编码逆向 | ✅ 已有 |
| `docs/qodercli-auth-decryption.md` | Auth 文件解密 | ✅ 已有 |
| `docs/qoder-encoding-reference.md` | 编码快速参考 | ✅ 已有 |
| `docs/frida-analysis.md` | Frida Hook 方案 + DYLD injection | ✅ 已有 |

## 时间线

| 时间 | 事件 |
|------|------|
| 2026-04-05 | 其他 agent 完成请求体编码逆向 |
| 2026-04-05 | 其他 agent 完成 Auth 文件解密逆向 |
| 2026-04-06 10:46 | 捕获原始 LLM API 请求 |
| 2026-04-06 11:00 | 确认服务器接受纯 JSON |
| 2026-04-06 11:05 | 发现 JWT requestId 去重机制 |
| 2026-04-06 11:35 | 逆向 JWT 结构 |
| 2026-04-06 12:00 | 测试 15 种签名算法假设，全部失败 |
| 2026-04-06 12:30 | GoReSym 完成，找到全部函数地址 |
| 2026-04-06 12:45 | Frida hook 确认 getAuthSignature 参数映射 |
| 2026-04-06 13:00 | 签名算法完全逆向: `MD5(s1\ns2\ns3\ns4\ns5)` |
| 2026-04-06 13:15 | RSA 公钥捕获，info 字段生成链确认 |
| 2026-04-06 13:30 | 文档更新完成 |
