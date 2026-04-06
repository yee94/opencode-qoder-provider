# Qoder 请求体编码 - 快速参考

## 自定义 Base64 字母表

```
自定义: _doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!
标准:   ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/
```

**位置**: `~/.qoder/bin/qodercli/qodercli-0.1.38` 文件偏移 `0x20d5720`

## 解码 (Python)

```python
import base64

CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

def decode(encrypted: str) -> str:
    trans = str.maketrans(CUSTOM_ALPHABET, STANDARD_BASE64)
    translated = encrypted.translate(trans)
    padding = (4 - len(translated) % 4) % 4
    translated += '=' * padding
    return base64.b64decode(translated).decode('utf-8')

# 使用
with open('request.bin', 'r') as f:
    plaintext = decode(f.read())
```

## 编码 (JavaScript)

```javascript
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encode(plaintext) {
  const encoded = Buffer.from(plaintext, 'utf-8').toString('base64').replace(/=/g, '');
  const transTable = new Map();
  for (let i = 0; i < STANDARD_BASE64.length; i++) {
    transTable.set(STANDARD_BASE64[i], CUSTOM_ALPHABET[i]);
  }
  return encoded.split('').map(c => transTable.get(c) || c).join('');
}
```

## 关键汇编地址

| 项目 | 地址 | 说明 |
|------|------|------|
| `newEncoding` | `0x173dd61` (符号) | 编码器初始化 |
| `shuffle` | `0x173de05` (符号) | 字母表打乱 |
| `assemble64` | `0x173df85` (符号) | 64 位组装 |
| 字母表数据 | `0x20d5720` (文件偏移) | 64 字符常量 |
| cosy/encrypt 包 | `0x12b6c8a` (文件偏移) | 版本 v1.0.1 |

## 直接发送请求

```bash
# 使用项目脚本
node scripts/qoder-direct-request.js "Your question" --model efficient

# 选项
--model <name>        # efficient, performance, ultimate, lite, etc.
--stream <bool>       # 是否流式输出 (默认 true)
--thinking            # 启用思考模式
--max-tokens <n>      # 最大输出 token
--temperature <n>     # 温度 (0.0-1.0)
```

## 请求结构

```json
{
  "model": "efficient",
  "messages": [{
    "role": "user",
    "content": "...",
    "contents": [{"type": "text", "text": "..."}]
  }],
  "stream": true,
  "temperature": 0.7,
  "max_tokens": 32768,
  "thinking": {"type": "disabled"}
}
```

## API 端点

```
POST https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation
  ?FetchKeys=llm_model_result
  &AgentId=agent_common
  &Encode=1
```

## 必需 Headers

```
Content-Type: application/json
Accept: text/event-stream
Authorization: Bearer <access_token>
cosy-user: <uid>
cosy-machineid: <machine_id>
cosy-date: <timestamp>
cosy-version: 0.1.38
cosy-clienttype: 5
```

## 可用模型

| Model | 名称 | 倍率 |
|-------|------|------|
| `auto` | Auto | 1.0x |
| `efficient` | Efficient | 0.3x |
| `performance` | Performance | 1.1x |
| `lite` | Lite | Free |
| `ultimate` | Ultimate | 1.6x |
| `qmodel` | Qwen3.6-Plus | 0.2x |
| `q35model` | Qwen3.5-Plus | 0.2x |
| `gmodel` | GLM-5 | 0.5x |
| `kmodel` | Kimi-K2.5 | 0.3x |
| `mmodel` | MiniMax-M2.7 | 0.2x |

## 完整映射表

```
_→A  d→B  o→C  R→D  T→E  g→F  H→G  Z→H
B→I  K→J  c→K  G→L  V→M  j→N  l→O  v→P
p→Q  C→R  ,→S  @→T  a→U  F→V  S→W  x→X
#→Y  D→Z  P→a  u→b  N→c  J→d  m→e  e→f
&→g  i→h  *→i  M→j  z→k  L→l  O→m  E→n
n→o  )→p  s→q  U→r  r→s  t→t  h→u  b→v
f→w  %→x  Y→y  ^→z  w→0  .→1  (→2  k→3
I→4  Q→5  y→6  X→7  q→8  W→9  A→+  !→/
```

## 详细文档

完整的逆向分析过程参见: [qoder-request-encryption-reverse-engineering.md](./qoder-request-encryption-reverse-engineering.md)
