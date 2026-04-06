# Qoder CLI 逆向工程分析

## 概述

本文档记录对 qodercli 的逆向工程过程和成果，目标是**绕过 qodercli agent loop，向 Qoder LLM API 发送任意消息**。

**最终方案**: DYLD_INSERT_LIBRARIES dylib 注入（路径 F）✅ 已验证成功，100% 确定性，无时序问题。

---

## 最终方案：DYLD_INSERT_LIBRARIES dylib 注入

### 核心思路

利用 macOS 的 `DYLD_INSERT_LIBRARIES` 机制注入一个极小 C dylib，在 Go `main()` 之前通过 `__attribute__((constructor))` 替换 `argv` 中的 placeholder 为真实消息。

### 为什么可行

1. qodercli 使用 cgo（链接 Foundation, libSystem 等），走标准 C startup 序列
2. dylib constructor 在 `main()` 之前执行 — Go runtime 还没初始化
3. 二进制为 ad-hoc 签名（`flags=0x2(adhoc)`），无 hardened runtime，DYLD_INSERT_LIBRARIES 不被阻止
4. 通过 `_NSGetArgv()` 访问的 argv 和 `main(argc, argv)` 的 argv 是同一份内存

### 前置条件

- macOS (darwin) — `_NSGetArgv` 和 `DYLD_INSERT_LIBRARIES` 是 macOS 特有机制
- qodercli 已用 ad-hoc 签名（`codesign -s - --force --deep --entitlements entitlements.plist qodercli`），需 `get-task-allow` entitlement
- 需要 Xcode command line tools（用于 `cc` 编译 dylib）

### dylib 源码

```c
// scripts/qoder-injector.c
#include <string.h>
#include <stdlib.h>
#include <crt_externs.h>

#define PLACEHOLDER "QODER_INJECT_P"

__attribute__((constructor))
static void inject_message(void) {
    const char *msg = getenv("QODER_MSG");
    if (!msg || !msg[0]) return;
    int argc = *_NSGetArgc();
    char **argv = *_NSGetArgv();
    for (int i = 0; i < argc; i++) {
        if (argv[i] && strcmp(argv[i], PLACEHOLDER) == 0) {
            argv[i] = strdup(msg);
            unsetenv("QODER_MSG");
            return;
        }
    }
}
```

编译：
```bash
cc -shared -o /tmp/qoder-injector.dylib scripts/qoder-injector.c -arch arm64
```

### 使用方式

```bash
# 直接调用
QODER_MSG="你的消息" \
DYLD_INSERT_LIBRARIES=/tmp/qoder-injector.dylib \
qodercli -p QODER_INJECT_P --max-turns 1 -f json -w /tmp

# Python 封装
python3 scripts/qoder-inject-dylib.py "What is 2+2?"
python3 scripts/qoder-inject-dylib.py "帮我解释快速排序" --debug --json
```

### 验证结果

| 测试 | 消息 | 结果 | 状态 |
|------|------|------|------|
| 简单英文 | "What is 2+2? Reply with ONLY the number" | `{"text": "4"}` | ✅ |
| 中文 | "用一句话解释什么是快速排序" | 完整中文回答 | ✅ |
| 长消息+代码块 | Python fibonacci 代码分析请求 | 正确分析回答 | ✅ |
| JSON 输出 | "1+1=?" 配合 `-f json` | 完整 JSON 结构 | ✅ |

### 关键发现

1. **Go 二进制不阻止 DYLD_INSERT_LIBRARIES**: 只要不是 Apple 签名 + hardened runtime，就不受 SIP 保护
2. **`_NSGetArgv()` 返回的是 `main(argc, argv)` 的同一份 argv**: constructor 修改后 Go runtime 直接读到新值
3. **无需关心 Zone B 签名**: 消息在 argv 层替换，qodercli 后续正常计算 signature，签名自然匹配
4. **`-f json` 输出**: qodercli 支持 JSON 格式输出，非常适合程序化解析

---

## 核心痛点：qodercli 是完整 Agent 黑盒，非纯 LLM API

### 问题描述

通过 `-f stream-json` 输出分析发现，qodercli 内部运行的是**完整 agent loop**，而非纯 LLM 补全接口：

```
[system]  → 声明可用工具列表 (Bash, Read, Write, Edit, Glob, Grep, ...)
[assistant] → LLM 生成 reasoning + tool_use (name: "Bash", input: {...})
[user]    → qodercli 自己执行了工具，返回 tool_result
[assistant] → 基于 tool_result 继续推理或生成最终回复
[result]  → 完成
```

qodercli 黑盒包含三层：
1. **内置 Tools 执行** — Bash/Read/Write/Edit 等由 qodercli 自己执行
2. **上下文/会话管理** — session ID、历史消息、系统 prompt 均由 qodercli 维护
3. **完整 agent loop** — 多轮工具调用→结果→再推理，直到 `--max-turns` 耗尽或 LLM 生成最终回复

### 对 opencode 集成的影响

opencode 的设计是**自己控制工具执行生命周期**（自定义工具、自定义沙箱、自定义权限）。但 qodercli 的 agent 黑盒导致：

| 能力 | 期望 | 实际 | 状态 |
|------|------|------|------|
| 拦截 tool_use 让 opencode 执行 | ✓ | qodercli 自己执行，无法拦截 | ❌ |
| 替换工具执行结果 | ✓ | tool_result 由 qodercli 内部生成 | ❌ |
| 注册自定义工具 | ✓ | 只能通过 MCP server 间接实现 | ⚠️ |
| 观察工具调用事件流 | ✓ | `-f stream-json` 可以看到 | ✅ |
| 限制可用工具 | ✓ | `--allowed-tools` / `--disallowed-tools` | ✅ |
| 跳过权限确认 | ✓ | `--dangerously-skip-permissions` | ✅ |
| 发送纯 LLM 补全请求 | ✓ | 不支持，始终走 agent loop | ❌ |
| 自定义系统 prompt | ✓ | 有 `--system-prompt` 但受限 | ⚠️ |

### 可能的前进路径

#### 路径 1：Zone B 签名逆向（直连 API）

**目标**：完全绕过 qodercli，直接调用 `api3.qoder.sh` 的 SSE endpoint。

**需要破解**：
- `signature` header — 32 字节 hex，基于请求体内容生成
- `cosy-key` header — 128 字节 URL-safe base64，用途不明
- `cosy-machinetoken` header — 机器身份凭证

**优势**：完全控制请求/响应，可以作为纯 LLM completion API  
**风险**：签名算法在 Go 二进制中，逆向工作量大；服务端可能频繁更换签名逻辑  
**评估**：高收益 + 高风险 + 高工作量

#### 路径 2：寻找纯 Completion API Endpoint

**目标**：找到不含 agent behavior 的 API endpoint（如果存在）。

**方法**：
- 分析 qodercli 二进制中的 URL 字符串，寻找其他 endpoint
- 监控 qodercli 不同模式下的网络请求
- 分析 `AgentId` 参数是否可以切换行为模式

**评估**：低工作量，但可能不存在这样的 endpoint

#### 路径 3：Frida hook agent loop 内部

**目标**：在 qodercli 内部拦截 tool_use 事件，阻止自动执行，转发给 opencode。

**方法**：
- Hook tool 执行函数，替换为 noop 或自定义逻辑
- 通过 IPC（pipe/socket）将 tool_use 转发给外部进程
- 外部进程执行后将 tool_result 注入回 qodercli

**评估**：极高复杂度，Go runtime + Frida 交互问题已被验证难以可靠实现

#### 路径 4：`--max-turns 1` + `--disallowed-tools "*"`（最务实）

**目标**：强制 qodercli 不执行任何工具，只返回 LLM 的第一轮输出（含 tool_use 意图）。

**方法**：
```bash
QODER_MSG="..." \
DYLD_INSERT_LIBRARIES=/tmp/qoder-injector.dylib \
qodercli -p QODER_INJECT_P --max-turns 1 --disallowed-tools "*" -f stream-json -w /tmp
```

**预期行为**：
- LLM 生成 tool_use → qodercli 无法执行（被 disallowed）→ 直接返回
- opencode 拿到 tool_use 意图 → 自己执行 → 构造新消息带 tool_result → 再次调用 qodercli

**优势**：利用已有的 DYLD 注入 + qodercli 原生参数，工作量最小  
**风险**：需要验证 `--disallowed-tools "*"` 是否真的阻止所有工具执行；多轮需要多次 spawn qodercli  
**评估**：低工作量 + 中等风险，**建议优先验证**

#### 路径推荐优先级

1. **路径 4** — 最务实，利用已有成果，先验证可行性
2. **路径 2** — 低成本探索，分析二进制中的 URL 字符串
3. **路径 1** — 高投入高回报，作为长期方案
4. **路径 3** — 复杂度过高，不推荐

---

## 技术参考

### 认证机制

```
Auth file: ~/.qoder/.auth/user (或 ~/.qoderwork/.auth/user)
加密算法: AES-128-CBC + PKCS7
Key 派生: macOS IOPlatformSerialNumber → hex → UUID → 前 16 字符
IV: a40bbb4543e5a6d8ab91fb4055697c33 (硬编码)
解密后：JSON { uid, access_token, refresh_token, expire_time, ... }
```

### HTTP Headers

| Header | 来源 | 说明 |
|--------|------|------|
| `Authorization` | `Bearer <access_token>` | JWT token from auth file |
| `cosy-user` | `uid` from auth | 用户 ID |
| `cosy-machineid` | 序列号派生 | 机器标识 UUID |
| `cosy-date` | `Date.now()` | Unix 时间戳 |
| `cosy-version` | `0.1.38` | 硬编码版本号 |
| `cosy-clienttype` | `5` | 客户端类型 |
| `cosy-key` | ? | 128 字节 URL-safe base64，可能用于请求签名 |
| `cosy-machinetoken` | ? | 机器身份凭证 |
| `signature` | ? | 32 字节 hex 请求签名 |

### 请求体编码

```
明文 JSON → 自定义 Base64 编码 → 发送
```

**自定义字母表** (binary offset 0x20d5720):
```
_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!
```

**重要发现**: 请求体**仅使用自定义 base64 编码**，没有 AES 加密层。`cosy-key` 不参与请求体编码。

### API Endpoint

```
POST https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation
  ?FetchKeys=llm_model_result
  &AgentId=agent_common
  &Encode=1
```

**响应格式**: SSE (Server-Sent Events)，OpenAI 兼容的 chunk 格式

### 已知函数偏移（qodercli-0.1.38）

| 函数 | 偏移 | 说明 |
|------|------|------|
| `defaultModelContext.CreateUserMessage` | `0x867550` | 用户消息构建 |
| `CustomEncryptV1` | `0x1740670` | 自定义加密（实际是 base64） |
| `EncryptBody` | `0xc76a00` | 请求体编码入口 |
| `buildRequest` | `0x428240` | HTTP 请求构建 |
| `shouldEncryptBody` | `0x428a70` | 编码判断 |
| 自定义 base64 字母表 | `0x20d5720` | 64 字符映射表 |

### qodercli 二进制签名

用于 Frida attach 和 DYLD_INSERT_LIBRARIES 的前提：
```bash
# 创建 entitlements.plist
cat > /tmp/entitlements.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.get-task-allow</key>
  <true/>
</dict>
</plist>
EOF

# ad-hoc 重新签名
codesign -s - --force --deep --entitlements /tmp/entitlements.plist \
  ~/.qoder/bin/qodercli/qodercli-0.1.38
```

---

## 集成到 opencode-qoder-provider

### 当前架构

```
opencode → QoderLanguageModel.doStream()
  → QoderAgentSDKClient (vendored SDK)
    → spawn qodercli subprocess
      → stdin/stdout JSON protocol
```

### DYLD 注入方案集成

```
opencode → QoderLanguageModel.doStream()
  → subprocess.spawn(qodercli, { env: { QODER_MSG, DYLD_INSERT_LIBRARIES } })
    → qodercli -p QODER_INJECT_P --max-turns N -f json
      → stdout JSON → parse → ReadableStream<V2StreamPart>
```

### 收益

- 可发送任意消息，不受 vendored SDK 限制
- 自动携带所有认证（token、signature、cosy-key 等由 qodercli 处理）
- 100% 确定性，无时序竞争

### 风险

- **macOS only**: DYLD_INSERT_LIBRARIES 是 macOS 特有机制，Linux 需要 `LD_PRELOAD` 方案
- **版本依赖**: qodercli 更新后需验证 `-f json` 输出格式不变
- **ad-hoc 签名**: 每次 qodercli 更新需重新签名

---

## 探索历程摘要

在找到最终方案（路径 F）之前，经历了多个技术路径的探索：

| 路径 | 方案 | 结果 | 失败原因 |
|------|------|------|----------|
| A | Frida hook 加解密函数 | 未实现 | Go 寄存器调用约定复杂，偏移量版本依赖 |
| B | Frida hook Go HTTP Client | 未实现 | interface 参数解析复杂，结构体布局不确定 |
| C | 内存 Patch 跳过加密 | ❌ 不推荐 | GC 干扰，指令 Patch 风险高 |
| D | 独立 API Client（纯 Node.js） | 部分完成 | `signature` header 无法独立生成（Zone B 签名校验） |
| E | Frida 内存注入（扫描+覆盖） | ⚠️ 技术验证成功 | **时序竞争**：qodercli < 300ms 发出 HTTP，Frida 扫描需 300-2700ms |
| **F** | **DYLD_INSERT_LIBRARIES** | **✅ 成功** | — |

### 路径 E 时序问题详情

这是最接近成功的 Frida 方案，核心问题记录如下：

| 模式 | byte_done | 扫描时间 | 结果 |
|------|-----------|----------|------|
| Spawn + 立即 patch | 0 | ~100ms | ❌ Go runtime 未初始化，placeholder 不在 rw- 区域 |
| Attach + 0ms sleep | 14 | 2700ms | ⚠️ 扫描太慢 |
| Attach + 50-200ms | 3 | 300ms | ⚠️ 副本太少 |
| Attach + 300ms | 16 | 360ms | ❌ HTTP 已发出 |

Go String 内存结构 `(ptr uintptr, len int)` 各 8 字节，修复时必须同时更新 ptr 和 len。UTF-8 多字节字符必须在 Python 端编码为字节数组传入 Frida（`charCodeAt()` 返回 UTF-16）。

---

## 参考文件

| 文件 | 说明 |
|------|------|
| `scripts/qoder-injector.c` | DYLD 注入 dylib 源码 |
| `scripts/qoder-inject-dylib.py` | DYLD 方案 Python 封装（生产可用） |
| `scripts/frida-hook-encrypt.js` | Frida hook 脚本（历史参考） |
| `scripts/frida-intercept-http.js` | HTTP 拦截脚本（历史参考） |
| `scripts/qoder-direct-api.js` | 独立 API Client（路径 D，部分完成） |
| `docs/qodercli-auth-decryption.md` | 认证文件解密 |
| `docs/qoder-request-encryption-reverse-engineering.md` | 请求加密逆向 |
| `docs/qoder-encoding-reference.md` | 编码格式参考 |

---

## SDK 控制协议深入分析（2024 年新增）

### YOLO 模式完整链路分析

**YOLO 模式不是全局配置，而是插件代码硬编码的**：

- `qoder-language-model.ts:343,382` 中 `permissionMode: 'bypassPermissions'` → SDK 转换为 `--yolo` CLI flag
- 没有 `~/.qoder/settings.json` 或其他全局配置开启 yolo
- SDK `buildCommand()` (vendor/qoder-agent-sdk.mjs line 605-606): `permissionMode === "bypassPermissions"` → `cmd.push("--yolo")`
- SDK `initContext` (line 2152-2154): 只在 `bypassPermissions` 时设置 `initContext.permissionMode`

**权限模式对比**：

| 模式 | CLI 标志 | 行为 |
|------|---------|------|
| `default` | (无) | qodercli 以 default 模式运行 |
| `bypassPermissions` | `--yolo` | 跳过所有权限检查和 hooks |
| `acceptEdits` | (无) | 自动接受编辑类操作 |
| `plan` | (无) | 先显示计划后执行 |

### SDK prompt 交付 bug

`QoderAgentSDKClient.connect(prompt)` 中存在一个关键 bug，导致在特定条件下 prompt 被丢弃：

**问题代码** (vendor/qoder-agent-sdk.mjs line 2440, 2491)：

```javascript
// Line 2440: string prompt 在没有 canUseTool 时被丢弃
let finalPrompt = typeof actualPrompt === "string" ? emptyStream() : actualPrompt;

// Line 2491: 没有 canUseTool 时，string prompt 不触发 streamInput
const shouldStreamInput = prompt !== void 0 && (typeof prompt !== "string" || this.options.canUseTool);
```

**行为矩阵**：

| prompt 类型 | canUseTool | finalPrompt | shouldStreamInput | 结果 |
|------------|-----------|-------------|-------------------|------|
| string | ✗ | emptyStream() | false | ❌ prompt 丢失，qodercli 永远收不到消息 |
| string | ✓ | stringToAsyncIterable() | true | ✅ 正常工作 |
| AsyncIterable | ✗ | 原始值 | true | ✅ 正常工作 |
| AsyncIterable | ✓ | 原始值 | true | ✅ 正常工作 |

**影响**：之前的 `pretooluse-hook-deny.test.ts` 测试中，`client.connect('Read the file ...')` 传入 string prompt + 无 canUseTool → prompt 被丢弃 → qodercli 启动但永远收不到用户消息 → 会话挂住 120 秒后超时。

**修复方案**：使用 `AsyncIterable<SDKUserMessage>` 传递 prompt，绕过此 bug。

### permission_mode: "default" 行为分析

通过 SDK 日志 (`~/.qoder/logs/qoder-agent-sdk-typescript.log`) 深度分析确认：

**在 `permission_mode: "default"` + 无 hooks 注册时**：
- qodercli 仍然直接执行工具，**不发送任何 `control_request`**
- SDK 日志 Line 6383: `permission_mode: "default"`, hooks: null
- LLM 发出 `tool_use(Read)` → qodercli 直接执行 → 返回文件内容
- 这说明 qodercli 的 "default" 模式仅在**有外部 hooks/权限系统注册时**才会发送 control_request

**canUseTool 回调失败的根因**：
- `canUseTool` 在 SDK 中设置 `permissionPromptToolName: "stdio"`
- 但此值**从未传递给 qodercli CLI**：
  - `SubprocessTransport.buildCommand()` 不处理 `permissionPromptToolName`
  - `TcpTransport` 的 `initContext` 中也不包含
- qodercli 从不发送 `control_request(subtype: "can_use_tool")`，回调永远不触发

**从未被正确测试的关键组合**：
- hooks 已注册（通过 initialize 协议）+ prompt 正确交付（AsyncIterable）+ 非 yolo 模式
- 这是下一步验证实验的目标

### 更新后的路径评估

基于以上分析，路径优先级调整为：

#### 路径 5：PreToolUse hooks + AsyncIterable prompt + 非 yolo（新增，优先验证）

**目标**：验证 qodercli 在 hooks 已注册 + prompt 正确交付 + default 权限模式下，是否会发送 `hook_callback` control_request。

**方法**：
1. 使用 `QoderAgentSDKClient`（非 query()）
2. 传入 prompt 作为 `AsyncIterable<SDKUserMessage>` — 绕过 prompt 交付 bug
3. 注册 `hooks: { PreToolUse: [{ hooks: [denyHook] }] }`
4. **不设置** `permissionMode: 'bypassPermissions'` — 确保非 yolo
5. 观察 qodercli 是否发送 `hook_callback` 类型的 control_request

**预期结果**：
- 如果 hook 被触发 → 🎉 完美方案，可以拦截工具调用让 opencode 执行
- 如果 hook 仍未触发 → qodercli 的 hook 机制可能存在根本性限制

**评估**：低工作量，高潜在收益，**最优先验证**

#### 更新后优先级

1. **路径 5** — PreToolUse hooks 正确验证（新增）
2. **路径 4** — `--max-turns 1` + DYLD 注入（已有方案）
3. **路径 2** — 寻找纯 Completion API
4. **路径 1** — Zone B 签名逆向
5. ~~路径 3~~ — Frida hook agent loop（不推荐）

### 测试文件参考

| 文件 | 说明 | 结果 |
|------|------|------|
| `tests/integration/canuse-tool-deny.test.ts` | query() + canUseTool | ❌ 回调从未触发 |
| `tests/integration/canuse-client-mode.test.ts` | Client + canUseTool | ❌ 回调从未触发 |
| `tests/integration/pretooluse-hook-deny.test.ts` | Client + hooks + string prompt | ❌ prompt 未交付，挂住 |
| `tests/integration/pretooluse-hook-asynciter.test.ts` | Client + hooks + AsyncIterable prompt（待创建） | 🔲 待验证 |
