# Qoder JetBrains 插件逆向分析报告

## 1. 结论

**Qoder JetBrains 插件没有暴露直接的 LLM API（如 OpenAI 风格的 `/v1/chat/completions`）。**

它采用的是 **LSP（Language Server Protocol）over WebSocket** 架构：
- 插件作为 LSP Client
- 连接到本地的 LSP Server（通过 WebSocket）
- 所有 AI 能力通过 LSP 消息交互，而非 HTTP REST API

**对我们项目的启示**：
- 无法直接借鉴"HTTP 中间层"路线（如 claude-code-router）
- 我们的 `opencode-qoder-plugin` 当前路线（SDK `query()`）与 JetBrains 插件的 LSP 路线不同
- 如果追求"更直接的 LLM API"，需要 Qoder 官方暴露新的接口，或自行实现 LSP Client

---

## 2. 架构概览

```
┌─────────────────────────────────────────┐
│  JetBrains IDE (IntelliJ/PyCharm等)     │
│  - Qoder 插件 (LSP Client)              │
│  - 通过 WebSocket 连接到 LSP Server     │
└───────────────┬─────────────────────────┘
                │ WebSocket (LSP Protocol)
                ▼
┌─────────────────────────────────────────┐
│  Qoder LSP Server (本地或远程)          │
│  - 处理代码补全、聊天、工具调用等        │
│  - 与 Qoder 后端服务通信                │
└─────────────────────────────────────────┘
```

---

## 3. 关键发现

### 3.1 通信协议：LSP over WebSocket

**核心类**：
- `CosyWebSocketConnectClient` — WebSocket 客户端
- `LanguageWebSocketService` — LSP 消息处理服务
- `ChatService` — 聊天相关 LSP 方法

**WebSocket 端点**：
- 通过 `CosyWebSocketConnectClient` 连接到 LSP Server
- 不是直接连接到 LLM API，而是连接到 Qoder 的 LSP 服务层

### 3.2 聊天/对话能力

**ChatService 接口**（LSP 方法）：
```java
// 发起对话
CompletableFuture<Object> ask(ChatAskParam);

// 回复请求
CompletableFuture<Object> replyRequest(ChatReplyRequestParam);

// 停止生成
CompletableFuture<Object> stop(ChatStopParam);

// 获取会话列表
CompletableFuture<List<ChatSession>> listAllSessions(ListChatHistoryParams);

// 获取指定会话
CompletableFuture<ChatSession> getSessionById(GetChatSessionParams);

// 删除会话
CompletableFuture<Void> deleteSessionById(DelChatSessionParams);
```

**关键洞察**：
- 所有对话能力通过 LSP 方法暴露
- 没有直接的 "send message to LLM" API
- 会话管理由 LSP Server 维护

### 3.3 没有 HTTP REST API

**搜索结果**：
- 未找到 `RestTemplate`、`OkHttpClient`、`Retrofit` 等 HTTP 客户端库的直接使用
- 未找到 `/v1/chat/completions` 或类似 OpenAI API 的端点
- 所有外部通信通过 WebSocket/LSP 进行

**URL 常量**（仅文档/配置相关）：
- `https://docs.qoder.com/` — 文档
- `https://lingma.aliyun.com` — 阿里云灵码
- `https://help.aliyun.com/zh/lingma/` — 帮助文档
- 均为文档链接，非 API 端点

### 3.4 与 Qoder CLI/SDK 的关系

| 组件 | 通信方式 | 说明 |
|------|----------|------|
| JetBrains 插件 | LSP over WebSocket | 与 LSP Server 通信 |
| Qoder CLI/SDK | 子进程 + stdin/stdout | 直接启动 CLI 进程 |
| Qoder 后端 | 内部协议 | 由 LSP Server/CLI 对接 |

**关键差异**：
- JetBrains 插件不直接调用 CLI，而是通过 LSP Server
- LSP Server 可能由插件自动启动，或独立运行
- 我们的 `opencode-qoder-plugin` 直接调用 CLI（`query()`），与 JetBrains 路线不同

---

## 4. 为什么不能直接借鉴

### 4.1 架构差异

| 维度 | claude-code-router | Qoder JetBrains 插件 |
|------|-------------------|---------------------|
| 中间层 | HTTP 代理 | LSP Client |
| 协议 | HTTP REST | LSP over WebSocket |
| 劫持方式 | 环境变量 `ANTHROPIC_BASE_URL` | 不适用 |
| 模型调用 | 直接转发到 Provider API | 通过 LSP Server 中转 |

### 4.2 我们的处境

当前 `opencode-qoder-plugin`：
- 使用 `@ali/qoder-agent-sdk` 的 `query()` 方法
- 直接启动 `qodercli` 子进程
- 通过 stdin/stdout 与 CLI 通信

这与 JetBrains 插件的 LSP 路线不同，无法直接借鉴其架构。

---

## 5. 可能的改进方向

### 方案 A：继续使用 SDK `query()`（当前路线）

**优点**：
- 实现简单，无需额外依赖
- 与 Qoder CLI 版本同步更新

**缺点**：
- 每次冷启动 CLI 进程
- 多轮对话依赖 prompt 注入

### 方案 B：实现 LSP Client（参考 JetBrains 插件）

**优点**：
- 与 IDE 插件架构一致
- 可能获得更好的会话管理能力

**缺点**：
- 需要启动/管理 LSP Server
- 需要实现完整的 LSP 消息处理
- 复杂度大幅增加

### 方案 C：要求 Qoder 官方暴露 HTTP API

**优点**：
- 最干净的方案，类似 OpenAI API
- 易于集成和调试

**缺点**：
- 依赖官方支持
- 短期内不可行

---

## 6. 最终建议

**继续走方案 A（SDK `query()`），但优化多轮对话**：

1. **P0（已完成）**：优化 prompt 序列化、历史截断、tool result 结构化
2. **P1（推荐）**：引入 `sessionId` 复用 + `continue/resume`
3. **P2（可选）**：评估是否需要切换到 LSP Client 架构

**不要试图逆向 JetBrains 插件的 LSP 协议**：
- LSP 消息格式复杂，且可能随版本变化
- 官方未公开文档，维护成本高
- 与当前 SDK 路线不兼容

---

## 7. 附录：关键类清单

| 类名 | 路径 | 说明 |
|------|------|------|
| `CosyWebSocketConnectClient` | `core/websocket/` | WebSocket 客户端 |
| `LanguageWebSocketService` | `core/lsp/` | LSP 消息处理服务 |
| `ChatService` | `core/lsp/model/service/` | 聊天 LSP 方法 |
| `LanguageClient` | `core/lsp/model/` | LSP Client 接口 |
| `QoderUrls` | `constants/` | URL 常量（仅文档） |

---

## 8. 一句话总结

**Qoder JetBrains 插件使用 LSP over WebSocket 架构，没有暴露直接的 LLM HTTP API。我们的项目应继续优化 SDK `query()` 路线，而非试图切换到 LSP 架构。**
