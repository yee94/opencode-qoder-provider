#!/usr/bin/env python3
"""
qoder-inject-dylib.py — DYLD_INSERT_LIBRARIES 方案向 Qoder LLM 发送任意消息

原理：
  1. 编译一个极小的 C dylib，__attribute__((constructor)) 在 main() 前运行
  2. constructor 从 QODER_MSG 环境变量读取真实消息
  3. 遍历 argv 找到 placeholder "QODER_INJECT_P"，替换指针为真实消息
  4. Go runtime 读 os.Args 时已经是替换后的值
  5. qodercli 正常走 agent loop，但发送的是我们的消息
  6. 无 Frida 依赖，无时序问题，纯确定性方案

用法:
  python3 qoder-inject-dylib.py "What is 2+2?"
  python3 qoder-inject-dylib.py "帮我解释快速排序" --debug
  python3 qoder-inject-dylib.py "你好" --max-turns 3 --format json
"""

import subprocess
import sys
import os
import json
import argparse
import tempfile
import hashlib


PLACEHOLDER = "QODER_INJECT_P"

DYLIB_SOURCE = r"""
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
"""


def _resolve_qodercli() -> str:
    """查找 qodercli 二进制路径"""
    # 1. PATH 中查找
    for d in os.environ.get("PATH", "").split(os.pathsep):
        p = os.path.join(d, "qodercli")
        if os.path.isfile(p):
            real = os.path.realpath(p)
            if os.path.isfile(real):
                return real
    # 2. 标准安装位置
    local = os.path.expanduser("~/.qoder/local/qodercli")
    if os.path.isfile(local):
        return os.path.realpath(local)
    # 3. 版本目录
    bin_dir = os.path.expanduser("~/.qoder/bin/qodercli")
    if os.path.isdir(bin_dir):
        entries = sorted(
            [e for e in os.listdir(bin_dir) if e.startswith("qodercli-")],
            reverse=True,
        )
        if entries:
            p = os.path.join(bin_dir, entries[0])
            if os.path.isfile(p):
                return p
    raise FileNotFoundError("找不到 qodercli，请先运行 qoder login")


def _ensure_dylib(debug: bool = False) -> str:
    """确保 dylib 已编译，返回路径。使用源码 hash 做缓存。"""
    src_hash = hashlib.md5(DYLIB_SOURCE.encode()).hexdigest()[:8]
    dylib_path = os.path.join(tempfile.gettempdir(), f"qoder-injector-{src_hash}.dylib")

    if os.path.isfile(dylib_path):
        if debug:
            print(f"[debug] dylib 缓存命中: {dylib_path}", file=sys.stderr)
        return dylib_path

    # 写源码 + 编译
    src_path = dylib_path.replace(".dylib", ".c")
    with open(src_path, "w") as f:
        f.write(DYLIB_SOURCE)

    result = subprocess.run(
        ["cc", "-shared", "-o", dylib_path, src_path, "-arch", "arm64"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"dylib 编译失败: {result.stderr}")

    if debug:
        print(f"[debug] dylib 编译成功: {dylib_path}", file=sys.stderr)

    return dylib_path


def query(
    message: str,
    max_turns: int = 1,
    output_format: str = "json",
    workdir: str | None = None,
    debug: bool = False,
    timeout: int = 120,
) -> dict:
    """
    通过 DYLD_INSERT_LIBRARIES 注入向 Qoder LLM 发送消息。

    Args:
        message: 发送给 LLM 的消息
        max_turns: 最大 agent 迭代轮数
        output_format: 输出格式 ("json" 或 "text")
        workdir: qodercli 工作目录
        debug: 打印调试信息
        timeout: 超时秒数

    Returns:
        解析后的 JSON 响应（format=json 时），或 {"text": "..."} 字典
    """
    qodercli = _resolve_qodercli()
    dylib = _ensure_dylib(debug=debug)

    if workdir is None:
        workdir = tempfile.gettempdir()

    cmd = [
        qodercli,
        "-p", PLACEHOLDER,
        "--max-turns", str(max_turns),
    ]
    if output_format == "json":
        cmd.extend(["-f", "json"])

    env = os.environ.copy()
    env["QODER_MSG"] = message
    env["DYLD_INSERT_LIBRARIES"] = dylib

    if debug:
        print(f"[debug] qodercli={qodercli}", file=sys.stderr)
        print(f"[debug] dylib={dylib}", file=sys.stderr)
        print(f"[debug] message ({len(message)} chars): {repr(message[:120])}", file=sys.stderr)
        print(f"[debug] cmd={cmd}", file=sys.stderr)
        print(f"[debug] workdir={workdir}", file=sys.stderr)

    result = subprocess.run(
        cmd,
        cwd=workdir,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )

    if debug:
        print(f"[debug] returncode={result.returncode}", file=sys.stderr)
        if result.stderr:
            print(f"[debug] stderr={result.stderr[:500]}", file=sys.stderr)

    stdout = result.stdout.strip()

    if output_format == "json" and stdout:
        try:
            return json.loads(stdout)
        except json.JSONDecodeError:
            if debug:
                print(f"[debug] JSON 解析失败, 原始输出: {stdout[:200]}", file=sys.stderr)
            return {"raw": stdout, "error": "json_decode_failed"}

    return {"text": stdout}


def extract_text(response: dict) -> str:
    """从 qodercli JSON 响应中提取纯文本"""
    if "text" in response:
        return response["text"]

    msg = response.get("message", {})
    content = msg.get("content", [])
    texts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            texts.append(block.get("text", ""))
    return "\n".join(texts) if texts else json.dumps(response, ensure_ascii=False)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="向 Qoder LLM 发送任意消息（DYLD_INSERT_LIBRARIES 方案）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python3 qoder-inject-dylib.py "What is 2+2?"
  python3 qoder-inject-dylib.py "帮我解释一下快速排序" --debug
  python3 qoder-inject-dylib.py "写一个 hello world" --max-turns 3
  python3 qoder-inject-dylib.py "Hello" --format text
  python3 qoder-inject-dylib.py "Hello" --json  # 输出原始 JSON
        """,
    )
    parser.add_argument("message", help="发送给 LLM 的消息")
    parser.add_argument("--max-turns", type=int, default=1, help="最大 agent 轮数（默认 1）")
    parser.add_argument("--format", choices=["json", "text"], default="json", help="qodercli 输出格式")
    parser.add_argument("--json", action="store_true", help="输出原始 JSON（不提取文本）")
    parser.add_argument("--debug", action="store_true", help="调试模式")
    parser.add_argument("--timeout", type=int, default=120, help="超时秒数")
    parser.add_argument("-w", "--workdir", help="qodercli 工作目录")
    args = parser.parse_args()

    response = query(
        args.message,
        max_turns=args.max_turns,
        output_format=args.format,
        workdir=args.workdir,
        debug=args.debug,
        timeout=args.timeout,
    )

    if args.json:
        print(json.dumps(response, ensure_ascii=False, indent=2))
    else:
        print(extract_text(response))


if __name__ == "__main__":
    main()
