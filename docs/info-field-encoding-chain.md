# ⚠️ 此文档有误 — 已纠正

**本文档的分析有误，请勿参考。**

错误分析：
- 文中假设 `info` 字段来自 RSA-PKCS1v15 加密 → 实际来自 `userInfo struct offset 0x80`，可能是 `encrypt_user_info` (748 chars) 的某种转换结果
- RSA 公钥和 `encrypt.RsaEncrypt` 存在于二进制中，但与 `info` 字段的直接关系未确认

正确结论：
- `info` 字段来源：`getAuthPayload` (VA `0x100419560`) 从 `userInfo+0x80` 读取（len from `userInfo+0x88`）
- `GenerateAuthToken` (VA `0x100416df0`) 传入：`ldr x1, [userInfo + 0x80]` / `ldr x2, [userInfo + 0x88]`
- 可能的源字段：`encrypt_user_info` (748 chars) from `shared_client/cache/user`
- 长度差异：info 在 payload 中约 446 chars（从 base64_payload=752 反推），但 `encrypt_user_info` 是 748 chars

详见 `docs/rsa-key-discovery.md` 和 `docs/cosy-jwt-signature-algorithm.md`。

---

（以下为原始分析记录，仅供参考）

**日期**: 2025-04-06  
**目标二进制**: qodercli-0.1.38 (Go ARM64)  
**分析类型**: 动态反汇编 + 符号表分析

---

## 1. 概述

本文档追踪 qodercli 中 `info` 字段从输入到最终 RSA 加密 token 的完整编码链。

**关键发现**:
- `info` 字段作为参数直接传入 `getAuthPayload`
- 成为 JSON payload 的一部分
- 整个 JSON (包含 info) 被 RSA-1024 加密
- 加密结果经过多层编码 → 最终 336 字符的认证 token

---

## 2. 调用链追踪

### 2.1 GenerateAuthToken (VA 0x100416df0)

**反汇编片段** (disasm_GenerateAuthToken.txt, line 29-30):
```asm
100416e48: 940009c6    bl  0x100419560      ; 调用 getAuthPayload
100416e4c: f90043e0    str x0, [sp, #0x80]  ; 保存结果 (payload 指针)
100416e50: f90037e1    str x1, [sp, #0x68]  ; 保存结果 (payload 长度)
```

### 2.2 getAuthPayload (VA 0x100419560)

**作用**: 构建包含 info 字段的 JSON payload

**关键字段构建** (disasm_getAuthPayload.txt):

| 行号 | 指令 | 含义 |
|-----|------|------|
| 1004195d0-1004195d4 | 加载 "sys" | 系统信息字段 |
| 1004195f8 | 加载 "model" | 模型字段 |
| 1004196c8 | `ldr x2, [sp, #0x60]` + `str x2, [x0, #0x8]` | **info 字段设置** |
| 1004196f0 | 加载 "version" | 版本字段 |

**info 字段来源** (disasm_getAuthPayload.txt, line 72):
```asm
100419650: f94037e4    ldr x4, [sp, #0x68]  ; 加载 info 参数
100419654: f9000404    str x4, [x0, #0x8]   ; 存储到 JSON 对象
```

**结论**: `info` 字段在这里是 **直接参数** 传递，不做加密处理

### 2.3 从 GenerateAuthToken 到 签名

**GenerateAuthToken 继续执行** (line 44-45):
```asm
100416e84: 9400094b    bl  0x1004193b0      ; 调用 getAuthSignature
100416e88: f9003fe0    str x0, [sp, #0x78]  ; 保存签名结果
100416e8c: f90033e1    str x1, [sp, #0x60]  ; 保存签名长度
```

---

## 3. 编码链分析

### 3.1 已知数据点

| 阶段 | 字节数 | 字符数 | 说明 |
|-----|-------|-------|------|
| RSA-1024 输出 | 128 | 256 (hex) | 来自 RsaEncrypt |
| 中间处理结果 | 252 | ? | 输入给 CustomBase64 |
| 最终 Base64 输出 | ? | 336 | 认证 token |

### 3.2 转换推导

```
RSA 加密 (128 bytes)
    ↓
? 处理
    ↓
252 字节数据
    ↓
自定义 Base64 编码 (4/3 压缩)
    ↓
336 字符最终 token
```

**计算验证**:
- 252 bytes × 4/3 = 336 chars ✓ (标准 base64 压缩率)

**空缺推导**:
- RSA(128 bytes) → 中间(252 bytes)
- 额外数据: 252 - 128 = **124 字节**

### 3.3 可能的中间处理

#### 假设 A: Hex 编码 + MD5

```
RsaEncrypt(128 bytes)
    ↓ hex encode
256 字符 hex 字符串
    ↓ 转换回二进制或拼接
+ MD5(payload) = 16 bytes
+ 其他数据 = ~108 bytes
    ↓
252 字节
```

#### 假设 B: 结构化拼接

```
标记字节 (1-2 bytes)
+ RSA 输出 (128 bytes)
+ 时间戳 (8 bytes)  
+ 校验和/签名 (4 bytes)
+ 其他元数据 (10-115 bytes)
    ↓
252 字节
```

### 3.4 Md5Encode 函数分析

**地址**: 0x100380f70 - 0x100381140 (464 bytes)

**反汇编关键部分** (disasm_Md5Encode.txt):

```asm
100380fc4-100380fd0: MD5 初始化
    mov  x5, #0x2301
    movk x5, #0x6745 lsl 16
    movk x5, #0xab89 lsl 32
    movk x5, #0xefcd lsl 48
    ; x5 = 0xefcdab8967452301 (标准 MD5 IV)

100381050-100381078: 十六进制转换表
    adrp x4, 0x1013b4000
    add  x4, x4, #0x200
    ; x4 指向 hex 表: "0123456789abcdef"

100381084-100381110: 循环处理 (每个字节转 2 个 hex 字符)
    ldrb w3, [x5, x1]       ; 读取一个字节
    ubfx x4, x3, #4, #4     ; 提取高 4 位
    ldrb w4, [x6, x4]       ; 查表得到 hex 字符
    ...
    ldrb w3, [x6, x3]       ; 低 4 位转 hex 字符
```

**结论**: Md5Encode 函数是 **二进制→十六进制字符串转换器**，不是 MD5 哈希函数

---

## 4. RsaEncrypt 函数

**地址**: 0x100380cb0 - 0x100380e70 (448 bytes)

**符号信息** (goresym_output.json):
```json
{
    "Start": 4298640560,
    "End": 4298641008,
    "PackageName": "code.alibaba-inc.com/cosy/encrypt",
    "FullName": "code.alibaba-inc.com/cosy/encrypt.RsaEncrypt"
}
```

**推断**:
- RSA-1024 加密, 输出 128 bytes
- PKCS#1 v1.5 padding (标准)
- 在 getAuthSignature 中被调用

---

## 5. CustomBase64 编码表

**地址**: 0x1013b4000 + 0x180 (在 Md5Encode 反汇编中引用)

**64 字符字母表** (需要 dump):
```
标准: ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/
自定义: ? (待反向)
```

---

## 6. 编码链完整流程图

```
GenerateAuthToken(info, other_params)
    ↓
getAuthPayload(info)  
    ↓ (JSON 编码)
{"sys": "...", "model": "...", "info": "<info字段>", ...}
    ↓
JSON 序列化为字符串
    ↓
RsaEncrypt(JSON_string)
    ↓ (RSA-1024)
128 bytes 密文
    ↓ getAuthSignature ?
    ↓ [中间处理 124 bytes]
    ↓
252 字节数据
    ↓ CustomBase64(字节, 自定义字母表)
    ↓
336 字符认证 token
```

---

## 7. 关键地址总结

| 地址/范围 | 功能 | 说明 |
|----------|------|------|
| 0x100416df0 | GenerateAuthToken | 主入口 |
| 0x100419560 | getAuthPayload | JSON 构建 |
| 0x1004193b0 | getAuthSignature | 签名逻辑 |
| 0x100380cb0 | RsaEncrypt | RSA 加密 |
| 0x100380f70 | Md5Encode | Hex 转换 (非 MD5) |
| 0x1013b4000+0x180 | CustomBase64 表 | 编码字母表 |
| 0x1013b4000+0x200 | HexTable | "0123456789abcdef" |

---

## 8. 验证方法

### 通过 Frida Hook 验证

```javascript
// Hook getAuthPayload
Interceptor.attach(Module.findExportByName(null, "getAuthPayload"), {
    onLeave: function(retval) {
        console.log("Payload:", Memory.readUtf8String(retval));
    }
});

// Hook RsaEncrypt
Interceptor.attach(Module.findExportByName(null, "RsaEncrypt"), {
    onLeave: function(retval) {
        console.log("RSA output (128 bytes):", Memory.readByteArray(retval, 128));
    }
});
```

---

## 9. 后续待逆向问题

1. **中间 124 字节来源**
   - [ ] 确认是否包含 MD5 哈希
   - [ ] 是否包含时间戳
   - [ ] 是否包含其他签名数据

2. **CustomBase64 字母表**
   - [ ] 从 0x1013b4000+0x180 dump 64 个字符
   - [ ] 与标准 Base64 对比差异

3. **getAuthSignature 完整逻辑**
   - [ ] RSA 加密后的处理步骤
   - [ ] 是否有额外的 HMAC 计算

4. **Info 字段的用途**
   - [ ] 是否在客户端验证中使用
   - [ ] 影响 token 有效性的因素

---

## 10. 相关文档

- [JWT 签名算法分析](./cosy-jwt-signature-algorithm.md)
- [自定义 Base64 编码](./custom-base64-encoding.md)
- [RSA 密钥发现](./rsa-key-discovery.md)
- [Qodercli Auth 解密](./qodercli-auth-decryption.md)

---

**最后更新**: 2025-04-06  
**确认度**: ⭐⭐⭐ (高 - 反汇编明确, 但中间处理细节待验证)
