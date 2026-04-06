# ⚠️ 此文档有误 — 已纠正

**本文档的分析有误，请勿参考。**

错误分析：
- 文中将 `bl 0x10036f1d0` 识别为 Cosy-Key 生成函数 → 实际是 `go.uber.org/zap.(*SugaredLogger).log`（日志调用）
- 认为 `0x1025abd40` 是 Cosy-Key 数据 → 实际是 BSS 段运行时数据（日志上下文）

正确结论：
- `Cosy-Key` = `key` 字段（172 字符），来自 `~/.qoder/shared_client/cache/user` 的 JSON `key` 字段
- 从 `GenerateAuthToken` (VA `0x100416df0`) 返回值 x2,x3 确认
- `Cosy-Key` 和 JWT sig 的 `s2` (machineToken) 是同一个值

详见 `docs/cosy-jwt-signature-algorithm.md` 和 `docs/standalone-api-call.md`。

---

（以下为原始分析记录，仅供参考）

**日期**: 2025-04-06  
**目标二进制**: qodercli-0.1.38 (Go ARM64)  
**函数**: addBigModelAuthHeaders (VA 0x100422eb0)

---

## 1. Cosy Headers 概览

从反汇编和 strings 输出中发现的完整 Cosy 系列 headers:

### 1.1 Header 清单

```
Cosy-Key              - 认证密钥/凭证
Cosy-ClientIp         - 客户端 IP
Cosy-MachineId        - 机器 ID
Cosy-MachineType      - 机器类型
Cosy-Organization-Id  - 组织 ID
Cosy-Organization-Tags - 组织标签
Cosy-Codebase-Tags    - 代码库标签
Cosy-Codebase-Status  - 代码库状态
Cosy-Codebase-Soft-Status - 代码库软状态
Cosy-Codebase-External-Id - 代码库外部 ID
Cosy-Codebase-Git-Remotes - Git 远程地址
Cosy-Version          - 协议版本
Cosy-User             - 用户信息
Cosy-Date             - 日期时间
Cosy-ClientType       - 客户端类型
Cosy-Data-Policy      - 数据策略
```

---

## 2. addBigModelAuthHeaders 反汇编分析

### 2.1 函数位置和大小

**地址**: 0x100422eb0 - 0x100423394  
**大小**: ~1188 bytes  
**栈帧**: 0x110 bytes

### 2.2 函数入口

```asm
100422eb0: d10443f4    sub x20, sp, #0x110      ; 分配栈空间
100422eb4: a93ffa9d    stp x29, x30, [x20, #-0x8]
100422eb8: 9100029f    mov sp, x20
100422ebc: d10023fd    sub x29, sp, #0x8
```

### 2.3 Cosy-Key Header 设置过程

#### 第一阶段: 数据准备 (line 100422f38-100422fb8)

```asm
100422f38: b0010c5b    adrp x27, 0x1025ab000       ; 加载全局数据区基地址
100422f3c: f946a360    ldr  x0, [x27, #0xd40]      ; 加载 Cosy-Key 源数据
                                                   ; x0 = *(0x1025ab000 + 0xd40)

100422f40: b24003e1    orr  x1, xzr, #0x1          ; x1 = 1 (flag/length?)
100422f44: d0004f22    adrp x2, 0x100e08000        ; 加载字符串基地址
100422f48: 913f3842    add  x2, x2, #0xfce         ; x2 = 字符串常量地址
                                                   ; x2 = 0x100e08000 + 0xfce

100422f4c: d2800283    mov  x3, #0x14              ; x3 = 20 (十进制)
100422f50: aa1f03e4    mov  x4, xzr                ; x4 = 0
100422f54: aa1f03e5    mov  x5, xzr                ; x5 = 0
100422f58: aa0503e6    mov  x6, x5                 ; x6 = 0
100422f5c: 910303e7    add  x7, sp, #0xc0          ; x7 = 栈缓冲区
100422f60: b27f03e8    orr  x8, xzr, #0x2          ; x8 = 2
100422f64: aa0803e9    mov  x9, x8                 ; x9 = 2

100422f68: 97fd309a    bl   0x10036f1d0            ; 调用关键函数
                                                   ; 参数: x0-x9
                                                   ; 返回值: x0, x1
```

#### 第二阶段: 结果处理

```asm
100422fa4: d0007c81    adrp x1, 0x1013b4000        ; 加载转换表基地址
100422fa8: 910d0021    add  x1, x1, #0x340
100422fac: f90073e1    str  x1, [sp, #0xe0]        ; 存储表地址

100422fb0: f90077e0    str  x0, [sp, #0xe8]        ; 存储 Cosy-Key 结果
100422fb4: d0004e00    adrp x0, 0x100de4000        ; 加载字符串基地址
100422fb8: 911e3400    add  x0, x0, #0x78d         ; 字符串偏移

; 此时 x0 指向 "Cosy-Key" 字符串
; x0[0xe8] 指向 Cosy-Key 的值
```

#### 第三阶段: Header 设置

```asm
100422fcc: 97f38fe5    bl   0x100106f60            ; 设置 HTTP header
                                                   ; 参数:
                                                   ; x0 = "Cosy-Key" 字符串
                                                   ; x1 = flag (0x2)
                                                   ; x2 = [x0 + 0x8]
                                                   ; x3 = 1
```

### 2.4 其他 Cosy Headers 的类似模式

**Cosy-ClientIp** (line 100423118-100423150):
```asm
100423118: d0004e40    adrp x0, 0x100ded000
100423120: 912d8000    add  x0, x0, #0xb60         ; 字符串地址
100423124: b27d03e1    orr  x1, xzr, #0x8          ; 长度 = 8
                                                   ; "Cosy-User" (9 chars)
```

**Cosy-Date** (line 1004231d0-1004231e4):
```asm
1004231d0: 90004e60    adrp x0, 0x100def000
1004231d4: 912c0000    add  x0, x0, #0xb00         ; 字符串地址
1004231d8: d2800121    mov  x1, #0x9               ; 长度 = 9
```

**Cosy-Version** (line 100423284-100423298):
```asm
100423284: d0004ea0    adrp x0, 0x100df9000
100423288: 91099400    add  x0, x0, #0x265         ; 字符串地址
10042328c: d28001a1    mov  x1, #0xd               ; 长度 = 13
```

---

## 3. Cosy-Key 值来源分析

### 3.1 源数据地址: 0x1025ab000 + 0xd40

**内存区域分析**:
- 基地址: 0x1025ab000 (数据段/BSS 段)
- 偏移: 0xd40
- 完整地址: 0x1025abd40

**推测**:
- 这是某个全局变量或结构体的字段
- 可能在程序启动时初始化
- 包含 clientId、deviceId、machineId 或其他标识符

### 3.2 处理函数: 0x10036f1d0

**函数签名推断**:
```c
unknown_t process_cosy_key(
    uint64_t source_data,      // x0
    uint64_t flag,             // x1 = 1
    const char *string_const,  // x2 = 0x100e08fce
    uint64_t param3,           // x3 = 0x14 (20)
    uint64_t param4,           // x4 = 0
    uint64_t param5,           // x5 = 0
    uint64_t param6,           // x6 = 0
    uint64_t buffer,           // x7 = sp[0xc0]
    uint64_t flag2,            // x8 = 2
    uint64_t flag3             // x9 = 2
);
```

**可能的实现**:
1. HMAC 计算: `HMAC-SHA256(source_data, string_const)`
2. 签名操作: `Sign(source_data, key)`
3. 加密: `Encrypt(source_data, key)`
4. 哈希: `Hash(source_data + string_const)`

### 3.3 字符串常量: 0x100e08000 + 0xfce

**推断**:
- 这是某个密钥、盐值或格式字符串
- 可能用于生成 Cosy-Key 的签名/加密
- 20 字节长度 (0x14) 提示

---

## 4. 编码/转换表

### 4.1 表地址: 0x1013b4000 + 0x340

```asm
100422fa4: d0007c81    adrp x1, 0x1013b4000
100422fa8: 910d0021    add  x1, x1, #0x340
```

**推测**:
- Base64 编码表或 Hex 查找表
- 大小: 256 bytes (标准 lookup table)
- 用于结果编码

---

## 5. 地址到字符串的映射

### 5.1 从反汇编提取的 Header 名字符串地址

| 地址 | 计算 | 字符串 | 长度 |
|-----|------|--------|------|
| 0x100de4000+0x78d | `911e3400` | "Cosy-Key" | ? |
| 0x100ded000+0xb60 | `912d8000` | ? | 8 |
| 0x100def000+0xaf7 | `912bdc00` | ? | 9 |
| 0x100def000+0xb00 | `912c0000` | ? | 9 |
| 0x100df9000+0x265 | `91099400` | ? | 13 |

### 5.2 推断匹配

从字符串长度反推:
- 8 chars: "Cosy-Key" (实际是 8), "Cosy-User" (9)
- 9 chars: "Cosy-Date" (9)
- 13 chars: "Cosy-Version" (12), "Cosy-Organization-Id" (20), ...

---

## 6. 编码流程完整图

```
全局数据 (0x1025abd40)
    ↓ (clientId/deviceId/machineId)
    
process_cosy_key(data, flags, key_string, params...)
    ↓
    ├─ 可能: HMAC-SHA256(data, key_string)
    ├─ 可能: SHA256(data + key_string)
    └─ 可能: RSA 签名(data)
    
    ↓ (返回值在 x0:x1)
    
转换表应用 (0x1013b4000 + 0x340)
    ↓ (可能: Base64 编码或 Hex 转换)
    
最终 Cosy-Key 值
    ↓ (存储在 sp[0xe8])
    
设置为 HTTP Header
```

---

## 7. 其他 Cosy Headers 的值来源

### 7.1 Cosy-MachineId

**推测来源**:
- 可能从 `0x1025ab000` 的其他字段
- 或通过系统调用获取 (gethostname, uname, 等)

### 7.2 Cosy-Date

**推测来源**:
- 时间戳
- 可能通过 `time.Now()` 获取
- 格式: RFC3339 或自定义

### 7.3 Cosy-ClientIp

**推测来源**:
- 本地 IP 地址
- 通过 socket 或网络库获取

### 7.4 Cosy-Organization-Id / Cosy-Organization-Tags

**推测来源**:
- 从认证信息中获取
- 来自 auth cache (`~/.qoder/.auth/user`)

---

## 8. 验证方法

### 8.1 Frida Hook

```javascript
// Hook process_cosy_key
Interceptor.attach(Module.findExportByName(null, "process_cosy_key"), {
    onEnter: function(args) {
        console.log("=== process_cosy_key called ===");
        console.log("arg0 (source_data):", args[0]);
        console.log("arg2 (string_const):", Memory.readUtf8String(args[2]));
    },
    onLeave: function(retval) {
        console.log("Result x0:", retval);
    }
});

// Hook addBigModelAuthHeaders
Interceptor.attach(Module.findExportByName(null, "addBigModelAuthHeaders"), {
    onLeave: function(retval) {
        console.log("HTTP Headers set successfully");
    }
});
```

### 8.2 HTTP 拦截

监听 qodercli 的 HTTP 请求，检查 Cosy-Key header 的实际值:
```bash
mitmproxy --mode transparent --listen-host 127.0.0.1 --listen-port 8888
```

---

## 9. 后续待逆向问题

1. **确认处理函数 0x10036f1d0**
   - [ ] 完整反汇编
   - [ ] 确认是 HMAC、签名还是其他

2. **字符串常量 0x100e08fce**
   - [ ] Dump 具体内容
   - [ ] 确认用途

3. **全局变量 0x1025abd40**
   - [ ] 确认初始化时机
   - [ ] 值的格式和范围

4. **编码表 0x1013b4340**
   - [ ] Dump 256 字节内容
   - [ ] 与标准编码的对比

5. **其他 Cosy Headers 的生成**
   - [ ] 完整追踪每个 header 的来源
   - [ ] 是否所有都经过类似的加密/编码

---

## 10. 关键地址总结

| 地址 | 功能 | 说明 |
|-----|------|------|
| 0x100422eb0 | addBigModelAuthHeaders | 主函数 |
| 0x10036f1d0 | ? 处理函数 | Cosy-Key 生成 |
| 0x100106f60 | ? 设置函数 | HTTP Header 设置 |
| 0x1025abd40 | 全局数据 | Cosy-Key 源数据 |
| 0x100e08fce | 字符串常量 | 处理参数 |
| 0x1013b4340 | 转换表 | 编码查找表 |

---

## 11. 相关文档

- [Info 字段编码链](./info-field-encoding-chain.md)
- [HTTP Signature Headers](./http-signature-headers.md)
- [Cosy JWT 分析](./cosy-jwt-analysis.md)
- [Frida 分析](./frida-analysis.md)

---

**最后更新**: 2025-04-06  
**确认度**: ⭐⭐ (中 - 流程清晰但具体实现细节待确认)  
**优先级**: 🔴 高 (Cosy-Key 是关键认证元素)
