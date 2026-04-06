#!/usr/bin/env bash
# qoder-test-intercept.sh — 端到端验证 mitmproxy 拦截方案
#
# 步骤：
#   1. 生成示例 payload → /tmp/qoder-payload.json
#   2. 后台启动 mitmdump（带 addon 脚本）
#   3. 用 HTTPS_PROXY 启动 qodercli，触发一次请求
#   4. 检查 mitmdump 输出是否包含拦截成功标志
#   5. 清理
#
# 前置条件：
#   - qoder login 已完成
#   - mitmdump 已安装（pip install mitmproxy）
#   - ~/.mitmproxy/mitmproxy-ca-cert.pem 存在

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADDON="$SCRIPT_DIR/qoder-intercept.py"
PAYLOAD_FILE="/tmp/qoder-payload.json"
MITM_LOG="/tmp/qoder-intercept-test.log"
MITM_PORT=18081   # 使用非标准端口，避免冲突
CERT="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[TEST]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }

# ── 1. 检查前置条件 ──────────────────────────────────────────────────────────
log "Checking prerequisites..."

command -v mitmdump >/dev/null 2>&1 || fail "mitmdump not found. Run: pip install mitmproxy"
command -v qodercli >/dev/null 2>&1 || fail "qodercli not found in PATH"
[ -f "$CERT" ] || fail "mitmproxy CA cert not found at $CERT. Run mitmdump once to generate it."
[ -f "$ADDON" ] || fail "Addon script not found: $ADDON"

log "✓ All prerequisites met"

# ── 2. 生成示例 payload ──────────────────────────────────────────────────────
log "Writing test payload to $PAYLOAD_FILE..."
python3 "$SCRIPT_DIR/qoder-payload-example.py"
log "✓ Payload written"

# ── 3. 启动 mitmdump ──────────────────────────────────────────────────────────
log "Starting mitmdump on port $MITM_PORT..."
QODER_INTERCEPT_DEBUG=1 mitmdump \
    --listen-port "$MITM_PORT" \
    --set "flow_detail=0" \
    -s "$ADDON" \
    > "$MITM_LOG" 2>&1 &
MITM_PID=$!

# 等待 mitmdump 就绪
sleep 2
if ! kill -0 "$MITM_PID" 2>/dev/null; then
    fail "mitmdump failed to start. Check log: $MITM_LOG"
fi
log "✓ mitmdump started (PID: $MITM_PID)"

# ── 4. 运行 qodercli 触发请求 ────────────────────────────────────────────────
log "Running qodercli with proxy..."
QODER_OUTPUT="/tmp/qoder-intercept-output.txt"

HTTPS_PROXY="http://127.0.0.1:$MITM_PORT" \
SSL_CERT_FILE="$CERT" \
qodercli -p "hi, reply with one word" \
    > "$QODER_OUTPUT" 2>&1 &
QODER_PID=$!

# 等待响应（最多 30 秒）
log "Waiting for response (max 30s)..."
ELAPSED=0
while kill -0 "$QODER_PID" 2>/dev/null && [ $ELAPSED -lt 30 ]; do
    sleep 1
    ELAPSED=$((ELAPSED + 1))
done

if kill -0 "$QODER_PID" 2>/dev/null; then
    warn "qodercli still running after 30s, killing..."
    kill "$QODER_PID" 2>/dev/null || true
fi

# ── 5. 检查结果 ──────────────────────────────────────────────────────────────
log ""
log "=== mitmdump log ==="
cat "$MITM_LOG"
log ""
log "=== qodercli output ==="
cat "$QODER_OUTPUT"

# 检查是否有拦截成功标志
if grep -q "\[INTERCEPT\] ✓ Replaced request" "$MITM_LOG" 2>/dev/null; then
    log ""
    log "✅ SUCCESS: Intercept worked! Custom payload was sent to Qoder API."
    grep "\[INTERCEPT\]" "$MITM_LOG" || true
else
    warn ""
    warn "⚠ INTERCEPT marker not found in mitmdump log."
    warn "Possible reasons:"
    warn "  - qodercli didn't make an agent_chat_generation request"
    warn "  - SSL cert issue (check CERT=$CERT)"
    warn "  - payload file issue"
fi

# ── 6. 清理 ──────────────────────────────────────────────────────────────────
log ""
log "Cleaning up..."
kill "$MITM_PID" 2>/dev/null || true
wait "$MITM_PID" 2>/dev/null || true
log "Done."
