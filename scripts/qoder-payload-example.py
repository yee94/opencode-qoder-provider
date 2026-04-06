#!/usr/bin/env python3
"""
qoder-payload.json 示例

这是发送给 Qoder LLM API 的明文 OpenAI 格式 payload。
将此文件复制到 /tmp/qoder-payload.json 后启动拦截 proxy。

字段说明：
  - model: Qoder 模型 ID（lite/auto/ultimate/performance/efficient 等）
  - messages: OpenAI 格式消息数组
  - stream: 必须为 true（Qoder API 只支持 SSE 流式）
  - temperature, max_tokens: 可选
"""

EXAMPLE_PAYLOAD = {
    "model": "lite",
    "messages": [
        {
            "role": "user",
            "content": "请用一句话介绍你自己。"
        }
    ],
    "stream": True,
    "temperature": 0.7,
    "max_tokens": 512
}

if __name__ == "__main__":
    import json, sys
    output_path = "/tmp/qoder-payload.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(EXAMPLE_PAYLOAD, f, ensure_ascii=False, indent=2)
    print(f"Written example payload to {output_path}")
    print(json.dumps(EXAMPLE_PAYLOAD, ensure_ascii=False, indent=2))
