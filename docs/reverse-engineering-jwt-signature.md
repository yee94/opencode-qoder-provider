# 逆向工程 JWT 签名过程

## 状态: ✅ 完成

签名算法已从 qodercli 二进制中完全逆向。完整文档见 `docs/cosy-jwt-signature-algorithm.md`。

## 最终结果

### 签名算法

```
sig = MD5(base64_payload \n machineToken \n timestamp \n s4 \n url_path)
```

- 函数: `getAuthSignature` (VA `0x1004193b0`)
- MD5 实现: `encrypt.Md5Encode` (VA `0x100380f70`)
- 标准 `crypto/md5`，无 HMAC
- `machineToken`: 从 auth 文件解密（`cosy_machinetoken` 字段，172 字节）
- `s4`: LLM 调用时为空字符串（首次调用 96 字节 body hash，不需要）
- 分隔符: `\n`（换行符）

### 完整 JWT 构建链

```
GenerateAuthToken (VA 0x100416df0)
  → GetCachedUserInfo() — 获取 accessToken, machineToken
  → getAuthPayload() — JSON → json.Marshal → base64.StdEncoding
  → getAuthSignature() — MD5(s1\ns2\ns3\ns4\ns5) → 32-char hex
  → fmt.Sprintf("Bearer COSY.%s.%s", b64_payload, sig)
```

### HTTP Signature（独立于 JWT）

```
Signature = MD5("cosy&d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==&<Date>")
```

详见 `docs/http-signature-headers.md`。

---

## 以下保留原始分析过程（历史记录）

## 二进制分析发现

### 1. 字符串搜索关键发现

使用 `strings` 命令搜索 qodercli 二进制文件，找到以下关键信息：

#### 认证相关字符串

| 字符串 | 位置 | 说明 |
|--------|------|------|
| `Bearer COSY.%s.%s` | 格式化字符串 | JWT 头构建模板，两个 `%s` 分别对应 payload 和 signature |
| `panic in Signature` | 错误消息 | 签名函数 panic 时的消息 |
| `Cosy-Key` | HTTP 头 | 另一个认证相关的头（可能是签名密钥） |
| `Cosy-Date` | HTTP 头 | 请求时间戳 |
| `Cosy-Version` | HTTP 头 | 客户端版本 |

#### Go 包路径

```
code.alibaba-inc.com/cosy/acp-sdk-go
code.alibaba-inc.com/cosy/ai-code-commit-tracker
code.alibaba-inc.com/cosy/common
code.alibaba-inc.com/cosy/encrypt
```

**关键发现**: `code.alibaba-inc.com/cosy/encrypt` 包很可能包含 JWT 签名和加密逻辑。

#### API 端点

```
/algo/api/v1/ping
/algo/api/v2/user/plan
/api/v1/userinfo
/api/v1/heartbeat
/algo/api/v2/service/pro/sse/agent_chat_generation
```

### 2. COSYENC1 加密格式

二进制文件中包含 `COSYENC1` 字符串，这可能是一种加密格式标识符。

**推测**: JWT 的 `info` 字段或签名可能使用 COSYENC1 格式加密。

### 3. 认证流程字符串

```
Login Successful - Lingma
Refresh token has expired
Failed to get user status
Authenticated via
USER_INFO is empty
user info is empty
```

这些字符串表明认证流程涉及 Lingma（阿里云灵码）服务。

## JWT 结构回顾

从 `docs/cosy-jwt-analysis.md` 已知的 JWT 结构：

```
COSY.{base64_payload}.{signature}
```

Payload:
```json
{
  "cosyVersion": "0.1.38",
  "ideVersion": "",
  "info": "<448字符加密数据>",
  "requestId": "<UUID>",
  "version": "v1"
}
```

Signature: `06cec1f722a2900d8afe5d3097b8b256` (32 字符十六进制 = MD5)

## 签名算法推测

### 假设 1: HMAC-MD5

```
signature = HMAC_MD5(secret_key, "COSY." + payload_base64)
```

**问题**: 我们无法从二进制文件中提取 `secret_key`

### 假设 2: 简单 MD5 拼接

```
signature = MD5("COSY" + payload_base64 + secret_key + timestamp)
```

**问题**: 同样需要知道 secret_key

### 假设 3: 服务器端签名

签名可能在登录时由服务器生成，客户端只负责存储和使用。这种情况下：
- 登录成功后，服务器返回完整的 JWT（包含签名）
- 客户端缓存该 JWT
- 每次请求时修改 `requestId` 但保留签名（**这会导致签名无效**）

**证据**: 我们修改 `requestId` 后请求超时/无响应，说明服务器验证了签名。

## Frida Hook 方案

由于静态分析受限（Go 二进制文件符号表被裁剪），我们需要使用 Frida 进行动态分析。

### Hook 策略

#### 1. Hook 网络发送函数

监控包含 "COSY" 的 HTTP 请求：

```javascript
Interceptor.attach(Module.findExportByName(null, 'SSL_write'), {
  onEnter: function(args) {
    const buf = args[1];
    const len = args[2].toInt32();
    try {
      const data = buf.readUtf8String(Math.min(len, 4096));
      if (data.includes('COSY.')) {
        console.log('[SSL_write] JWT request:');
        console.log(data.substring(0, 1000));
      }
    } catch (e) {}
  }
});
```

#### 2. Hook 加密函数

拦截 CommonCrypto / OpenSSL 调用：

```javascript
// CommonCrypto (macOS)
const CCCrypt = Module.findExportByName(null, 'CCCrypt');
if (CCCrypt) {
  Interceptor.attach(CCCrypt, {
    onEnter: function(args) {
      // args[0] = operation (encrypt/decrypt)
      // args[1] = algorithm (AES, etc)
      // args[2] = options
      // args[3] = key
      // args[4] = keyLength
      // args[5] = iv
      console.log('[CCCrypt] Called');
      console.log('  Algorithm:', args[1].toInt32());
      console.log('  Key:', hexdump(args[3], { length: args[4].toInt32() }));
    }
  });
}
```

#### 3. Hook Go 字符串构建

查找 JWT 构建函数：

```javascript
// Search for "Bearer COSY." in memory
const pattern = 'Bearer COSY.';
Memory.scanSync(Process.mainModule.base, Process.mainModule.size, pattern)
  .forEach(match => {
    console.log('Found "Bearer COSY." at:', match.address);
    // Then use stalker or backtrace to find calling function
  });
```

### 执行步骤

1. **启动 qodercli 并附加 Frida**:
   ```bash
   frida -l scripts/frida-jwt-analysis.js -f qodercli --no-pause
   ```

2. **触发认证请求**:
   ```bash
   qodercli "test"
   ```

3. **收集数据**:
   - JWT 生成前的输入参数
   - 加密函数的 key 和 IV
   - 最终的 JWT 输出

## 已知限制

### 1. Go 二进制文件混淆

- 函数名被 garble 混淆
- 符号表被裁剪
- 字符串可能部分加密

### 2. 密钥存储

签名密钥可能存储在：
- 内存中（登录后解密）
- 系统 Keychain (macOS)
- 加密的配置文件中

### 3. 时间敏感性

- JWT 可能包含时间戳 (`Cosy-Date`)
- 签名可能有时效性
- 重放攻击防护

## 替代方案

如果无法逆向签名算法，考虑以下替代方案：

### 方案 A: Hook 内存中的 JWT

在 JWT 生成后、发送前从内存中提取：

```javascript
// Hook HTTP request builder
// Find the function that adds Authorization header
// Extract the JWT from memory before it's sent
```

**优点**: 不需要理解签名算法
**缺点**: 每次请求都需要 Hook

### 方案 B: 使用 SDK 但绕过 Agent 控制

修改 `qoder-agent-sdk.mjs`，找到直接调用 LLM API 的函数：

```javascript
// 在 SDK 中找到发送 HTTP 请求的底层函数
// 绕过 Agent 逻辑，直接调用
```

**优点**: 利用已有的认证逻辑
**缺点**: 仍然依赖 SDK 文件

### 方案 C: 代理拦截 + 自动替换

设置本地代理，自动修改请求：

1. qodercli 发送请求到代理
2. 代理提取 JWT 和请求结构
3. 修改请求体中的用户消息
4. 转发到真实服务器

**优点**: 不需要逆向签名
**缺点**: 需要 qodercli 运行作为"认证代理"

## 下一步行动

### 优先级 1: Frida 动态分析

1. 运行 `scripts/frida-jwt-analysis.js`
2. 捕获 JWT 生成过程
3. 提取加密密钥和算法

### 优先级 2: SDK 代码分析

1. 反编译 `qoder-agent-sdk.mjs`
2. 查找 HTTP 请求构建逻辑
3. 提取认证头生成函数

### 优先级 3: 代理方案

如果逆向失败，实现代理方案作为后备。

## 相关文件

- JWT 结构分析: `docs/cosy-jwt-analysis.md`
- Frida Hook 脚本: `scripts/frida-jwt-analysis.js`
- 认证解密: `scripts/qoder-direct-api.js`
- 二进制文件: `~/.local/bin/qodercli`

## 时间线

| 时间 | 事件 |
|------|------|
| 2026-04-06 11:30 | 开始逆向 JWT 签名过程 |
| 2026-04-06 11:35 | 字符串搜索找到关键包路径和格式化字符串 |
| 2026-04-06 11:40 | 确认 `code.alibaba-inc.com/cosy/encrypt` 包 |
| 2026-04-06 11:45 | 创建 Frida Hook 脚本框架 |
| 2026-04-06 11:50 | 记录分析到本文档 |

## 结论

**当前状态**: ✅ **签名算法已完全逆向**

- ✅ 签名算法: `MD5(s1\ns2\ns3\ns4\ns5)` — 标准 MD5，无 HMAC
- ✅ machineToken: 从 auth 文件解密获得（`cosy_machinetoken`）
- ✅ HTTP Signature: 静态 secret + Date MD5
- ✅ 全部函数地址: GoReSym 确认
- ⚠️ `info` 字段: RSA 公钥已捕获，能否伪造待验证（见 `docs/rsa-key-discovery.md`）
