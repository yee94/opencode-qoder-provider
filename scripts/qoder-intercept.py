#!/usr/bin/env python3
"""
qoder-intercept.py — mitmproxy addon

拦截 qodercli 发出的 agent_chat_generation 请求，用 binary patch 策略
替换最后一条 user message，从而绕过 qodercli agent loop 直接控制发给
Qoder LLM 的实际 messages。

## Body 结构（抓包逆向分析，2025-04）

decoded body（custom_b64 解码后）的布局：
  [0       : ~25312]  加密区域（model、system prompt 前段、messages 前段等）
  [~25312  : 31343]   明文区域（system prompt XML 末尾 + messages 数组末尾）
  [31343   : 31345]   "]," — messages 数组结束标记
  [31345   : 50665]   tools 数组（明文 JSON）
  [50665   : end]     加密区域（business 等字段）

最后一条 user message 格式（明文，完全可 patch）：
  {"role":"user","content":"","contents":[{"type":"text","text":"<USER_INPUT>"}],
   "response_meta":{...},"reasoning_content_signature":""}

## Binary Patch 策略

不替换整个 body，而是：
  1. custom_b64 解码原始 body（保留所有加密区域）
  2. 找到最后一条 user message 的 "text":"<old>" 位置
  3. 替换为新 message 内容（支持长度变化）
  4. 重新 custom_b64 编码后发送

## 自定义 Base64 字母表（从 qodercli 二进制提取，offset 0x20d5720）

  _doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!

## 用法

    # 准备自定义 message（任意时刻）
    echo '{"message": "Hello! What is 2+2?"}' > /tmp/qoder-payload.json

    # 启动拦截 proxy（终端 1）
    mitmdump -s scripts/qoder-intercept.py --listen-port 8080

    # 用 proxy 启动 qodercli（终端 2），用任意 dummy prompt 触发请求
    HTTPS_PROXY=http://127.0.0.1:8080 \\
    SSL_CERT_FILE=~/.mitmproxy/mitmproxy-ca-cert.pem \\
    qodercli -p "dummy"

## 注意

    - SSL_CERT_FILE 让 qodercli (Go) 信任 mitmproxy 的自签 CA
    - 所有 auth headers（authorization, cosy-machinetoken, cosy-key 等）原样保留
    - payload.json 支持两种格式：
        {"message": "单条消息文本"}       ← 推荐，只替换最后一条 user message 的文本
        {"messages": [...]}               ← 兼容旧格式，只取最后一条 user 消息文本
    - 如果 payload 文件不存在或解析失败，请求会原样放行（不干预）
    - QODER_INTERCEPT_DEBUG=1 开启详细调试输出
    - SSE 响应格式：data:{"body":"{OpenAI_chunk_JSON}","statusCodeValue":200}
"""

import base64
import json
import os
import re
import sys
from mitmproxy import http

PAYLOAD_FILE = os.environ.get("QODER_PAYLOAD_FILE", "/tmp/qoder-payload.json")
DEBUG = os.environ.get("QODER_INTERCEPT_DEBUG", "0") == "1"

TARGET_HOST_PATTERN = re.compile(r"qoder\.sh")
TARGET_PATH_PATTERN = re.compile(r"agent_chat_generation")

# 自定义 Base64 字母表（从 qodercli 二进制提取，offset 0x20d5720）
CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!"
STANDARD_BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

# 预计算翻译表（标准 → 自定义）
_ENCODE_TRANS = str.maketrans(STANDARD_BASE64, CUSTOM_ALPHABET)
_DECODE_TRANS = str.maketrans(CUSTOM_ALPHABET, STANDARD_BASE64)


def _custom_b64encode(data: bytes) -> bytes:
    """将 bytes 编码为 qodercli 自定义 base64 格式（无 padding）。"""
    standard = base64.b64encode(data).decode("ascii")
    # 移除 padding，用自定义字母表替换
    custom = standard.rstrip("=").translate(_ENCODE_TRANS)
    return custom.encode("ascii")


def _custom_b64decode(data: str) -> bytes:
    """将 qodercli 自定义 base64 字符串解码为 bytes。"""
    # 过滤非字母表字符（如偶发的 $ 等），转回标准字母表，补 padding
    valid = "".join(c for c in data if c in CUSTOM_ALPHABET)
    standard = valid.translate(_DECODE_TRANS)
    padding = (4 - len(standard) % 4) % 4
    return base64.b64decode(standard + "=" * padding)


def _debug(msg: str) -> None:
    if DEBUG:
        print(f"[INTERCEPT] {msg}", file=sys.stderr, flush=True)


def _load_payload() -> str | None:
    """
    从 PAYLOAD_FILE 加载要注入的消息文本，失败返回 None。

    支持两种格式：
      {"message": "单条消息文本"}          ← 推荐
      {"messages": [{"role":"user","content":"..."},...]}  ← 兼容旧格式
    """
    try:
        with open(PAYLOAD_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)

        # 优先取 message 字段（新格式）
        if "message" in data:
            msg = str(data["message"])
            _debug(f"Loaded message from {PAYLOAD_FILE}: {msg[:80]!r}")
            return msg

        # 兼容旧格式：取最后一条 user 消息
        messages = data.get("messages", [])
        for msg in reversed(messages):
            if msg.get("role") == "user":
                content = msg.get("content", "")
                if content:
                    _debug(f"Loaded last user message from {PAYLOAD_FILE}: {content[:80]!r}")
                    return content

        print(f"[INTERCEPT] WARN: No usable message found in {PAYLOAD_FILE}", file=sys.stderr, flush=True)
        return None

    except FileNotFoundError:
        _debug(f"Payload file not found: {PAYLOAD_FILE} — passing through original request")
        return None
    except json.JSONDecodeError as e:
        print(f"[INTERCEPT] ERROR: Invalid JSON in {PAYLOAD_FILE}: {e}", file=sys.stderr, flush=True)
        return None


def _is_target_request(flow: http.HTTPFlow) -> bool:
    url = flow.request.pretty_url
    return bool(TARGET_HOST_PATTERN.search(url) and TARGET_PATH_PATTERN.search(url))


def _patch_message_in_body(decoded: bytes, new_message: str) -> bytes:
    """
    在已解码的 body bytes 中，将最后一条 user message 的文本替换为 new_message。

    目标格式（明文区域中的 JSON 片段）：
      "contents":[{"type":"text","text":"<CURRENT_TEXT>"}]

    策略：找最后一个 "text":"..." 并替换其值。
    如果找不到，原样返回（不 patch）。

    注意：如果新消息比原始消息短，用空格 padding 到原始长度，避免 body 大小变化。
    如果新消息更长，则允许 body 变大（服务端应该接受）。
    """
    # 找到最后一个 "text":" 的位置
    # 用 rfind 确保找到 messages 数组中最后一条消息的 text 字段
    marker = b'"text":"'
    idx = decoded.rfind(marker)
    if idx < 0:
        _debug("WARN: Could not find '\"text\":\"' in decoded body — passing through")
        return decoded

    # 找到值的起始和结束（结束是下一个非转义的 "）
    val_start = idx + len(marker)
    val_end = val_start
    while val_end < len(decoded):
        b = decoded[val_end]
        if b == ord('"') and decoded[val_end - 1] != ord('\\'):
            break
        val_end += 1

    original_text = decoded[val_start:val_end].decode("utf-8", errors="replace")
    _debug(f"Original message text: {original_text[:80]!r}")

    # 构建新的 bytes，替换文本值
    # new_message 需要 JSON 转义
    escaped_new = json.dumps(new_message, ensure_ascii=False)[1:-1]  # 去掉外层引号
    new_val_bytes = escaped_new.encode("utf-8")

    patched = decoded[:val_start] + new_val_bytes + decoded[val_end:]
    _debug(f"Patched message text: {new_message[:80]!r} ({len(decoded)} → {len(patched)} bytes)")
    return patched


def request(flow: http.HTTPFlow) -> None:
    if not _is_target_request(flow):
        return

    original_url = flow.request.pretty_url
    _debug(f"Intercepted: {flow.request.method} {original_url}")
    if DEBUG:
        _debug(f"Original headers: {dict(flow.request.headers)}")

    new_message = _load_payload()
    if new_message is None:
        # 没有 payload 文件 → 原样放行
        _debug("No payload, passing through")
        return

    # ── 1. 解码原始 body（custom base64 → bytes）──────────────────────────
    try:
        raw_body = flow.request.content.decode("ascii", errors="ignore")
        decoded = _custom_b64decode(raw_body)
        _debug(f"Decoded body: {len(decoded)} bytes")
    except Exception as e:
        print(f"[INTERCEPT] ERROR: Failed to decode body: {e}", file=sys.stderr, flush=True)
        return

    # ── 2. Binary patch：替换最后一条 user message 文本 ────────────────────
    patched = _patch_message_in_body(decoded, new_message)
    if patched is decoded:
        # patch 失败，原样放行
        return

    # ── 3. 重新 custom base64 编码 ──────────────────────────────────────────
    body_bytes = _custom_b64encode(patched)

    # ── 4. 替换 body ────────────────────────────────────────────────────────
    flow.request.content = body_bytes

    # ── 5. 修正 Content-Length（Content-Type 保持原样 application/json）──────
    flow.request.headers["content-length"] = str(len(body_bytes))

    # ── 6. 保留 Encode=1 和所有 auth headers（不要修改！）─────────────────────
    # Encode=1 是必须的，告知服务端 body 是 custom base64 编码
    # cosy-key / cosy-machinetoken / authorization 由 qodercli 生成，原样保留

    _debug(f"Body patched and re-encoded: {len(body_bytes)} bytes")
    _debug(f"Encode param: {flow.request.query.get('Encode', 'NOT SET')}")
    _debug(f"cosy-key present: {'cosy-key' in flow.request.headers}")
    _debug(f"Final URL: {flow.request.pretty_url}")

    # ── 7. 打印替换摘要到 stdout ────────────────────────────────────────────
    print(
        f"[INTERCEPT] ✓ Patched message → {new_message[:60]!r}, body={len(body_bytes)}B",
        flush=True,
    )


def response(flow: http.HTTPFlow) -> None:
    if not _is_target_request(flow):
        return

    status = flow.response.status_code if flow.response else "?"
    content_len = len(flow.response.content) if flow.response else 0
    _debug(f"Response: status={status}, body={content_len} bytes")

    if flow.response and flow.response.status_code == 200:
        # 打印前几个 SSE 事件以确认内容
        body_text = (flow.response.content or b"").decode("utf-8", errors="replace")
        lines = [l for l in body_text.split("\n") if l.startswith("data:")]
        print(f"[INTERCEPT] ✓ Response: status={status}, {len(lines)} SSE events", flush=True)
        # 打印前 2 个事件
        for line in lines[:2]:
            try:
                event_data = json.loads(line[5:])  # 去掉 "data:" 前缀
                inner = json.loads(event_data.get("body", "{}"))
                choices = inner.get("choices", [])
                if choices:
                    delta = choices[0].get("delta", {})
                    content = delta.get("content", "")
                    if content:
                        print(f"[INTERCEPT]   → {content!r}", flush=True)
            except Exception:
                pass
    elif flow.response and flow.response.status_code >= 400:
        body_preview = (flow.response.content or b"")[:500].decode("utf-8", errors="replace")
        print(
            f"[INTERCEPT] ⚠ Non-2xx response: status={status}\n{body_preview}",
            flush=True,
        )
