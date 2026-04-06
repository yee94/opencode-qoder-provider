# AGENTS.md

This is **opencode-qoder-plugin** — an [opencode](https://opencode.ai) plugin that injects Qoder AI models via a `config` hook. No manual provider configuration needed by users.

## Project Structure

```
opencode-qoder-plugin/
├── index.ts                     # Plugin entry — config hook + auth hook
├── provider.ts                  # Exports createQoderProvider() (opencode npm loader entry)
├── src/
│   ├── models.ts                # 11 built-in model definitions (injected by config hook)
│   ├── qoder-language-model.ts  # LanguageModelV2 implementation (doGenerate + doStream)
│   │   ├── Session management (fingerprint + resume)
│   │   ├── Client caching (signature-based reuse)
│   │   ├── Tool bridge (normalizeToolName + normalizeToolInput)
│   │   └── MCP bridge integration
│   ├── prompt-builder.ts        # AI SDK CallOptions → Qoder prompt / multimodal builder
│   ├── mcp-bridge.ts            # Converts opencode config.mcp → Qoder SDK mcpServers format
│   ├── agent-bridge.ts          # Detects available agent types from oh-my-opencode-slim plugins
│   └── vendor/
│       ├── qoder-agent-sdk.mjs  # Vendored Qoder Agent SDK — DO NOT modify
│       └── qoder-agent-sdk.d.ts # SDK type declarations — DO NOT modify
└── tests/
    ├── models.test.ts
    ├── plugin.test.ts
    ├── qoder-language-model.test.ts
    └── integration/
        ├── real-api.test.ts       # Requires `qoder login`
        └── opencode-cli.test.ts
```

## Key Design Decisions

- **Plugin, not provider config** — `index.ts` uses the `config` hook to inject `provider.qoder` automatically. Users only need `"plugin": ["opencode-qoder-plugin"]` in their `opencode.json`.
- **Dual auth paths** — checks `~/.qoderwork/.auth/user` first (QoderWork), then `~/.qoder/.auth/user` (Qoder CLI). If absent, surfaces a prompt telling users to run `qoder login`.
- **Vendored SDK** — `src/vendor/qoder-agent-sdk.mjs` is a bundled copy of `@ali/qoder-agent-sdk` (internal registry). Do not replace it without testing the full streaming pipeline.
- **Model merging** — builtin models from `src/models.ts` are injected first; any `provider.qoder.models` overrides in the user's `opencode.json` take precedence.
- **opencode主导工具调用** — opencode controls tool execution lifecycle; Qoder CLI handles only built-in tools (Read/Write/Bash/etc). Plugin bridges tool names and input formats between the two frameworks.
- **Session复用** — SHA256 fingerprint of system prompt + first user message maps to Qoder session ID. Subsequent calls with same fingerprint resume the existing session, avoiding full prompt rebuild.
- **Client缓存** — `QoderAgentSDKClient` instances are cached by permission signature. Matching signature → reuse; mismatch → create new client + connect().

## How the Streaming Pipeline Works

```
opencode → QoderLanguageModel.doStream()
  → buildSessionPlan()         # fingerprint → lookup/resume or new session
  → buildPromptFromOptions()   # text or multimodal (base64 image)
  → resolveQoderCLI()          # finds latest ~/.qoder/bin/qodercli/qodercli-<version>
  → getOrCreateClient()        # cache hit or new QoderAgentSDKClient + connect()
  → SDK query()                # streams SDKMessage events
      ├─ stream_event path     # incremental text / tool-input deltas (preferred)
      └─ assistant path        # full-block fallback
  → normalize tool names/inputs
  → ReadableStream<V2StreamPart>
```

### Tool Bridging

When Qoder CLI emits a `tool_use` block:

1. **normalizeToolName** — maps CLI names to opencode function names:
   - `Read` → `read`, `Write` → `write`, `Edit` → `edit`, `Bash` → `bash`
   - `AskUserQuestion` → `question`, `Agent` → `task`
   - `mcp__server__tool` → `server_tool`

2. **isProviderExecuted** — determines who runs the tool:
   - If tool name exists in opencode's `functionToolNames` → opencode executes it
   - Otherwise → Qoder CLI handles it internally

3. **normalizeToolInput** — converts camelCase↔snake_case:
   - `read`/`write`: `file_path` → `filePath`
   - `edit`: `old_string` → `oldString`, `new_string` → `newString`
   - `question`: `multiSelect` → `multiple`
   - `skill`: `skill` → `name`
   - `task`: maps `subagent_type` to internal identifiers

### Session Management

- **Fingerprint**: SHA256(system prompt + first user message) → 16-char hex
- **Session map**: `~/.qoder/.opencode-session-map.json` stores fingerprint → sessionId
- **Resume**: Matching fingerprint → sends only the last user message (not full history)
- **Fallback**: Fingerprint mismatch or session expired → creates new session

### Architecture Note: QoderWork vs This Plugin

QoderWork 主对话使用持久 `QoderAgentSDKClient` + `connect()` + 会话复用，工具调用在持久流内结构化处理。
本插件当前通过单次 `query()` 调用，依赖 session fingerprint 复用和 prompt 重建实现多轮。
这是有意为之的设计：opencode 主导工具调用生命周期，Qoder 专注生成。

## Development

```bash
npm install
npm test          # unit tests, no network required
```

## Release Process

Releases are automated via GitHub Actions:

1. Update `version` in `package.json`
2. Commit and push: `git commit -m "chore: release vX.Y.Z"`
3. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`
4. The **Publish** workflow triggers automatically and publishes to npmjs.com using `NPM_TOKEN` secret

> **NPM_TOKEN** must be set in GitHub repo Settings → Secrets → `NPM_TOKEN`.  
> Use an **Automation** type token from https://www.npmjs.com/settings/~/tokens to bypass OTP.

## Updating Model Definitions

The authoritative source for model parameters is the local Qoder auth cache:

```
~/.qoder/.auth/models   # JSON written by Qoder CLI on login/refresh
```

When Qoder releases new models or changes parameters, update `src/models.ts` to match the `assistant` array in that file. Field mapping:

| `~/.qoder/.auth/models` field | `QoderModelDefinition` field | Notes |
|-------------------------------|------------------------------|-------|
| `key` | `id` | model identifier passed to SDK |
| `is_vl` | `attachment` | vision/multimodal support |
| `is_reasoning` | `reasoning` | extended thinking mode |
| `max_input_tokens` | `limit.context` | |
| `max_output_tokens` | `limit.output` | |

After editing `src/models.ts`, also update the model table in `README.md` (both English and Chinese sections).

### Current model snapshot (from `~/.qoder/.auth/models` → `assistant`)

| Model ID | Name | Context | Input | Output | Attachment (`is_vl`) | Reasoning (`is_reasoning`) |
|----------|------|---------|-------|--------|----------------------|---------------------------|
| `auto` | Auto (1.0x) | 200K | 128K | 64K | ✓ | ✗ |
| `ultimate` | Ultimate (1.6x) | 200K | 128K | 64K | ✓ | ✓ |
| `performance` | Performance (1.1x) | 200K | 128K | 64K | ✓ | ✗ |
| `efficient` | Efficient (0.3x) | 200K | 128K | 64K | ✓ | ✗ |
| `lite` | Lite (free) | 200K | 128K | 64K | ✗ | ✗ |
| `q35model_preview` | Qwen3.6-Plus-DogFooding (0x) | 200K | 128K | 64K | ✓ | ✗ |
| `qmodel` | Qwen3.6-Plus (0.2x) | 200K | 128K | 64K | ✓ | ✗ |
| `q35model` | Qwen3.5-Plus (0.2x) | 200K | 128K | 64K | ✓ | ✗ |
| `gmodel` | GLM-5 (0.5x) | 200K | 128K | 64K | ✓ | ✗ |
| `kmodel` | Kimi-K2.5 (0.3x) | 200K | 128K | 64K | ✓ | ✗ |
| `mmodel` | MiniMax-M2.7 (0.2x) | 200K | 128K | 64K | ✓ | ✗ |

---

## Reverse Engineering Documentation Policy

All reverse engineering work (Frida hooks, binary analysis, HTTP traffic capture, JWT/signature analysis, etc.) MUST be documented in the `docs/` directory.

**When to document:**
- Any breakthrough or key finding (e.g., JWT structure, signature algorithm, API endpoints)
- Discovery of authentication mechanisms or encryption methods
- Binary analysis results (symbol tables, package paths, function locations)
- HTTP request/response format analysis
- Failed attempts with root cause analysis (proves what doesn't work)

**Documentation requirements:**
- Write conclusions immediately — don't wait until the task is complete
- Include technical details: code snippets, request/response samples, hex dumps
- Record failed experiments and why they failed (saves time for future work)
- Use markdown files with descriptive names in `docs/` directory
- Cross-reference related documents when findings build on previous work

**Current doc structure:**
```
docs/
├── cosy-jwt-analysis.md              # JWT structure and payload analysis
├── cosy-jwt-signature-algorithm.md   # ✅ COMPLETE: Full JWT sig algorithm (MD5)
│                                   #   s1=base64_payload, s2=machineToken (key field), s3=timestamp, s4=body_hash, s5=url_path
├── http-signature-headers.md         # ✅ COMPLETE: HTTP Signature/Appcode headers
│                                   #   MD5("cosy&d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==&<Date>")
├── rsa-key-discovery.md              # RSA public key (1024-bit PKCS1v15) and info field source
│                                   #   info field from userInfo+0x80 (AES-decrypted encrypt_user_info)
├── custom-base64-encoding.md         # Custom base64 alphabet reference
├── qodercli-auth-decryption.md       # Auth file AES-128-CBC decryption
├── qoder-request-encryption-reverse-engineering.md  # Request body encoding
├── reverse-engineering-jwt-signature.md # JWT sig reverse engineering (updated with complete破解)
├── standalone-api-call.md            # ✅ COMPLETE: Direct API call with cracked auth
├── frida-analysis.md                 # Frida hooks + DYLD injection (Path F ✅)
├── cosy-key-header-analysis.md       # ⚠️ OBSOLETE: Contains correction notice — Cosy-Key = machineToken, not zap.log
├── info-field-encoding-chain.md      # ⚠️ OBSOLETE: Contains correction notice — info is AES-decrypted, not RSA
└── re-engineering/                   # Consolidated artifacts for handoff
    ├── README.md                     # Index of all RE artifacts
    ├── frida-scripts/                # 2 useful scripts (v5 hooks)
    ├── disassembly/                  # 6 key function disassembly files
    └── captured-data/                # Minimal request captures
```

**Key breakthroughs:**
- **COSY JWT signature**: `MD5(s1\ns2\ns3\ns4\ns5)` — fully cracked, Node.js implementation ready
- **DYLD_INSERT_LIBRARIES injection**: Replaces argv placeholder before Go runtime, works for all CLI features including multimodal
- **machineToken source**: `key` field from `~/.qoder/shared_client/cache/user` (172 chars), NOT cosy_machinetoken
- **Cosy-Key header**: Equals machineToken (same value from GenerateAuthToken return x2,x3)
- **info field**: From userInfo struct offset 0x80, AES-decrypted from encrypt_user_info (not RSA-encrypted)
- **Custom base64**: Alphabet `_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!` with `$` padding

## What NOT to Do

- Do not modify `src/vendor/` files without thorough integration testing
- Do not add a `provider.qoder` block to `opencode.json` — the plugin injects it automatically
- Do not move `@opencode-ai/plugin` back to `devDependencies` — it must be in `dependencies` so opencode's Bun installer pulls it
