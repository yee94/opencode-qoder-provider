# QoderCLI Auth Token 解密算法逆向分析

> 逆向分析目标：`qodercli-0.1.38`（Go 1.24.0, macOS arm64）
> 分析日期：2026-04-05
> 目的：理解 `~/.qoder/.auth/user` 的加密机制，实现跨机器可复现的离线解密

---

## 1. 加密算法概述

### 1.1 文件位置

| 来源 | 路径 | 说明 |
|------|------|------|
| qodercli 登录 | `~/.qoder/.auth/user` | AES-128-CBC 加密 |
| QoderWork.app 登录 | `~/.qoderwork/.auth/user` | 格式可能不同，未分析 |

### 1.2 文件格式

`~/.qoder/.auth/user` 文件内容为 **base64 编码**的密文。base64 decode 后得到原始加密字节。

解密后的明文为 JSON，包含字段：`uid`、`name`、`email`、`organization`、`access_token`、`refresh_token`、`expire_time`、`refresh_expire`、`user_type`、`organization_tags`。

### 1.3 加密算法：AES-128-CBC

| 参数 | 值 | 说明 |
|------|-----|------|
| 算法 | AES-128-CBC | 128-bit key, CBC mode |
| Key 来源 | macOS `IOPlatformSerialNumber` | 通过 IOKit API 读取 |
| Key 派生 | 序列号 → hex → UUID v4 格式 → 取前 16 ASCII 字符 | 详见 §2 |
| IV | `a40bbb4543e5a6d8ab91fb4055697c33` | 硬编码于二进制中（§3.3 说明如何定位） |

---

## 2. Key 派生算法（完全确认）

### 2.1 算法步骤

1. 获取 macOS 序列号：通过 IOKit 读取 `IOPlatformSerialNumber`
2. 将序列号每个字符转为 ASCII hex
3. 格式化为 UUID v4 风格字符串
4. 取 UUID 字符串的**前 16 个 ASCII 字符**作为 AES-128 key

### 2.2 Python 实现

```python
def derive_key(serial: str) -> bytes:
    """
    从 IOPlatformSerialNumber 派生 AES-128 key。

    Args:
        serial: macOS 序列号，如 "PHPXL57F4R"

    Returns:
        16-byte AES key（ASCII 字符串的 bytes）
    """
    h = serial.encode().hex()  # "504850584c3537463452"

    # UUID v4 format:
    #   8 hex chars - 4 hex chars - 4(hex digit) - ...
    #   8 + 1 + 4 + 1 + 2 = 16 chars（取到 '-' 之前）
    #
    # 结构: XXXXXXXX-XXXX-4Y-...
    #   - 前 8 位来自 hex[0:8]
    #   - 接下来 4 位来自 hex[8:12]
    #   - version nibble 固定为 '4'
    #   - 第 14 位来自 hex[13]（原 hex 第 7 字节的低 4 位）
    key_str = f"{h[0:8]}-{h[8:12]}-4{h[13]}"  # 正好 16 chars
    return key_str.encode()
```

### 2.3 示例（不含个人信息）

```
输入序列号: <YOUR_SERIAL>  # 10 字符，因机器而异
hex: "504850584c3537463452"  # 示例，实际值不同
UUID 格式: "50485058-4c35-472d-8634-..."  # 完整 UUID（36 chars）
取前 16: "50485058-4c35-47"
AES Key:  b"50485058-4c35-47"  # 16 bytes
```

---

## 3. IV 来源

### 3.1 IV 值

```
IV (hex): a40bbb4543e5a6d8ab91fb4055697c33
```

IV **不是**文件头 16 字节（曾被误认为是文件头）。IV 硬编码于二进制中。

### 3.2 如何在新版本二进制中定位 IV

IV 是 AES-CBC 解密函数的输入参数之一。定位方法：

1. 找到 `decryptParam` 函数（§4.1 说明如何定位）
2. 该函数调用 Go 标准库 `crypto/cipher` 的 CBC 解密
3. IV 作为参数传入，通常以 16 字节常量存在于调用者的代码段中
4. 在 `decryptParam` 的调用点附近搜索 16 字节连续数据

---

## 4. 二进制逆向方法论（可复现）

本节说明如何在新版本 qodercli 中重新找到上述所有信息。

### 4.1 目标二进制

- 路径：`~/.qoder/bin/qodercli/qodercli-<version>`
- 类型：Mach-O 64-bit arm64（macOS Apple Silicon）
- 语言：Go（通过 `file` 命令确认）
- 大小：38.3 MB（0.1.38）
- Go 版本：Go 1.24.0

**Go 包路径（来自 pclntab 函数名，可确认模块来源）：**

| 包路径 | 说明 |
|--------|------|
| `code.alibaba-inc.com/qoder-core/qodercli/` | 主程序包 |
| `code.alibaba-inc.com/cosy/encrypt` | 加密库（COSYENC1 体系） |

这些路径在二进制中以明文保存于 pclntab 的 funcname 区，可直接读取。

### 4.2 定位 Go 函数名表（pclntab）

Go 二进制包含程序链接表（program line table），存储所有函数名和地址。

```bash
# 1. 在二进制中搜索 pclntab magic
# Go 1.18+: magic = 0xfffffff1
# Go 1.2/1.16: magic = 0xfffffffb
# 使用 radare2 或 Ghidra 搜索
r2 -q -c '/xfffffff1' ~/.qoder/bin/qodercli/qodercli-<version>

# 2. 定位后，解析 funcname 区域
# funcname 区通常在 pclntab 之后，包含所有 Go 函数名
```

关键函数名（用于搜索）：
- `device.getMachineSerialNumber` — 读取 IOPlatformSerialNumber
- `device.getDiskSerialNumber` — 读取磁盘序列号（备用路径，但 auth 解密不使用）
- `getMachineKey` — 顶层密钥获取函数
- `actualKeyCompute` — 实际 key 计算逻辑
- `ioreqReader` — IOKit 读取封装函数
- `keyFinalize` — key 最终处理
- `keyTransform` — key 变换（序列号 → hex → UUID）
- `decryptParam` — AES-CBC 解密函数

### 4.3 获取所有导入符号（IOKit stubs）

```bash
otool -Iv ~/.qoder/bin/qodercli/qodercli-<version>
```

关键 IOKit 导入符号及 stub VA 示例（0.1.38）：

| 函数 | stub VA |
|------|---------|
| `IOServiceGetMatchingService` | 0x100de28f8 |
| `IORegistryEntryFromPath` | 0x100de28e0 |
| `IORegistryEntryCreateCFProperty` | 0x100de28d4 |
| `IOServiceGetMatchingServices` | 0x100de2904 |
| `IOServiceMatching` | 0x100de2910 |
| `IOObjectRelease` | 0x100de28c8 |
| `IOIteratorNext` | 0x100de28bc |
| `CFStringGetCString` | 0x100de2880 |
| `CFRelease` | 0x100de2850 |

### 4.4 定位 IOKit 调用点

IOKit C 函数通过 stub 调用。在 Go 二进制中，调用 C 函数使用 `BL`（branch with link）指令跳转到 stub。

```bash
# 使用 radare2 或 Ghidra 在 IOKit stub 的交叉引用处下断点
# 或在二进制中搜索 BL 指令的目标地址
```

在 qodercli-0.1.38 中，IOKit 调用集中在 fileoff `0xddb550`–`0xddbd00` 范围内。

### 4.5 字符串混淆

**重要**：qodercli 对 IOKit 属性名（如 `"IOPlatformSerialNumber"`）进行了混淆。二进制中**不存在明文**的字符串。

- 混淆方式：运行时动态解密（可能是 XOR 或其他轻量级变换）
- 影响：无法通过 `strings` 或简单字符串搜索定位
- 对策：必须通过函数调用链和 pclntab 定位函数，而非字符串

### 4.6 fileoff 与 VA 转换

Mach-O arm64 的 VA 到 fileoff 转换：

```
fileoff = VA - __TEXT.__text 的 vmaddr + __TEXT.__text 的 fileoff
```

对于 qodercli-0.1.38（__TEXT.__text 起始于 VA 0x100004000, fileoff 0x4000）：
```
fileoff = VA - 0x100004000 + 0x4000 = VA - 0x100000000
```

即 `0x100405c90` → fileoff `0x405c90`。

### 4.7 关键函数地址表（qodercli-0.1.38）

| 函数名 | VA | fileoff | 说明 |
|--------|-----|---------|------|
| `getMachineKey` | 0x100405c90 | 0x405c90 | 顶层入口 |
| `actualKeyCompute` | 0x1003d5650 | 0x3d5650 | key 计算核心 |
| `ioreqReader` | 0x1003d5c70 | 0x3d5c70 | IOKit 读取封装 |
| `keyFinalize` | 0x1003d5b10 | 0x3d5b10 | key 最终处理 |
| `keyTransform` | 0x1003d5860 | 0x3d5860 | 序列号 → hex → UUID |
| `decryptParam` (AES-CBC) | 0x10041be70 | 0x41be70 | 解密函数 |
| IOKit C 函数区域 | ~0x100ddb5f0 | ~0xddb5f0 | C stub 调用区域 |

---

## 5. 完整解密流程

### 5.1 Python 解密脚本

```python
import base64
import json
from Crypto.Cipher import AES
from pathlib import Path

def get_serial_number() -> str:
    """获取 macOS IOPlatformSerialNumber"""
    import subprocess
    result = subprocess.run(
        ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
        capture_output=True, text=True
    )
    for line in result.stdout.split('\n'):
        if 'IOPlatformSerialNumber' in line:
            # 格式: | "IOPlatformSerialNumber" = "PHPXL57F4R"
            return line.split('"')[-2]
    raise RuntimeError("无法获取序列号")

def derive_key(serial: str) -> bytes:
    """从序列号派生 AES-128 key"""
    h = serial.encode().hex()
    key_str = f"{h[0:8]}-{h[8:12]}-4{h[13]}"
    return key_str.encode()

def decrypt_auth_file(path: str) -> dict:
    """解密 ~/.qoder/.auth/user 文件"""
    # 1. 读取 base64 并 decode
    ciphertext = base64.b64decode(Path(path).read_text())

    # 2. 派生 key
    serial = get_serial_number()
    key = derive_key(serial)

    # 3. 固定 IV
    iv = bytes.fromhex("a40bbb4543e5a6d8ab91fb4055697c33")

    # 4. AES-128-CBC 解密
    cipher = AES.new(key, AES.MODE_CBC, iv)
    plaintext = cipher.decrypt(ciphertext)

    # 5. 去除 PKCS7 padding
    pad_len = plaintext[-1]
    plaintext = plaintext[:-pad_len]

    # 6. 解析 JSON
    return json.loads(plaintext.decode('utf-8'))

# 使用示例
# result = decrypt_auth_file(Path.home() / ".qoder" / ".auth" / "user")
# print(json.dumps(result, indent=2))
```

### 5.2 跨机器复现条件

要在另一台机器上成功解密，需要：

1. **同一台机器**：key 派生依赖 `IOPlatformSerialNumber`，不同机器序列号不同
2. **相同 IV**：IV 硬编码于二进制中，同一版本 qodercli 的 IV 相同
3. **如果换了机器**：需要使用新机器的序列号重新派生 key（新机器登录后 `~/.qoder/.auth/user` 是用新机器的 key 加密的）

### 5.3 不同版本 qodercli

如果升级 qodercli，需要重新验证：

1. IV 是否变更：在 `decryptParam` 调用点检查
2. Key 派生算法是否变更：在 `keyTransform` 检查
3. 加密算法是否变更：在 `decryptParam` 检查（可能从 AES-128 变为 AES-256）

逆向方法见 §4。

---

## 6. 排除的错误方向

以下是在分析过程中走过的弯路，记录以避免重复：

| 方向 | 为什么错误 |
|------|-----------|
| `deriveMachineKey` 函数 | 该函数使用 `kern.hostname` + `HOME`，但 `getMachineKey` **不调用**它 |
| sha1/sha256/md5 of IOPlatformUUID | auth 解密使用的 key 来自 `keyTransform`（序列号），而非 hash |
| 文件头 16 字节 = IV | IV 是硬编码常量，与文件内容无关 |
| 通过 `strings` 搜索 "IOPlatformSerialNumber" | 字符串被混淆，不存在明文 |

---

## 7. 与插件的关系

`opencode-qoder-provider` 插件**不需要**实现自己的解密逻辑：

- `qoder-language-model.ts` 中 `configure({ storageDir })` 将目录传给 vendored SDK
- vendored SDK（`src/vendor/qoder-agent-sdk.mjs`）内部使用相同算法解密
- 插件依赖 qodercli 的 auth 缓存文件存在（用户需先 `qoder login`）

---

## 8. 附录：IOKit 读取序列号的 C 代码等价逻辑

```c
#include <IOKit/IOKitLib.h>

char* get_platform_serial() {
    io_service_t platformExpert = IOServiceGetMatchingService(
        kIOMasterPortDefault,
        IOServiceMatching("IOPlatformExpertDevice")
    );

    if (!platformExpert) return NULL;

    CFTypeRef serialNumberAsCFString = IORegistryEntryCreateCFProperty(
        platformExpert,
        CFSTR("IOPlatformSerialNumber"),
        kCFAllocatorDefault,
        0
    );

    IOObjectRelease(platformExpert);

    if (!serialNumberAsCFString) return NULL;

    // 转换为 C string
    char buffer[256];
    CFStringGetCString(serialNumberAsCFString, buffer, sizeof(buffer), kCFStringEncodingUTF8);
    CFRelease(serialNumberAsCFString);

    return strdup(buffer);
}
```

Go 二进制中通过 CGO 或内联汇编实现等价功能，调用相同的 IOKit API。

---

## 9. HTTP 请求加密体系（COSYENC1）

qodercli 对发往服务器的 HTTP 请求体进行了独立加密，体系与 auth 文件加密**完全不同**。

### 9.1 加密流程

```
明文 JSON
  → AES-CBC + PKCS5 加密（payload 加密）
  → AES key 用 RSA 公钥加密
  → 整体用自定义 Base64 编码
  → 加上格式标识符 "COSYENC1" 前缀
  → 作为 HTTP 请求体发送
```

格式标识符：`COSYENC1`（出现在加密请求体开头，用于服务端识别加密版本）

### 9.2 自定义 Base64 字母表（已完全还原）

```
_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!
```

**特征：**
- 共 64 个字符（标准 Base64 字母表大小）
- 包含特殊符号：`# % & ( ) * , . @ ^ _ !`
- **无数字（0-9）**
- 发现位置：二进制文件偏移 `34428704`（`0x20DD148`）

**在新版本中定位方法：**
```bash
# 搜索包含 64 个唯一非字母数字字符的连续字节序列
# 或通过 pclntab 找到 cosy/encrypt 包中的编码函数，分析其引用的常量
```

### 9.3 已提取的密钥材料

| 类型 | 说明 |
|------|------|
| RSA 1024-bit 公钥 | 从二进制静态提取，完整可用 |
| RSA 2048-bit 私钥 | 标记为 `-----END RSA TESTING KEY-----`，为测试用密钥 |

**注意**：2048-bit 私钥标注为 "TESTING KEY"，可能用于开发/测试环境；生产环境服务端持有配套私钥。提取到的公钥可用于验证加密流程，但无法解密服务端响应（除非拿到对应私钥）。

---

## 10. HTTP 流量分析

### 10.1 捕获方法

Go 程序内置 HTTP 调试环境变量，可输出完整 HTTP/2 请求响应：

```bash
GODEBUG=http2debug=2 ~/.qoder/bin/qodercli/qodercli-<version> <command>
```

此方法**无需代理、无需 SSL 证书安装**，直接打印明文调试输出。

### 10.2 捕获到的 API 端点

```
center.qoder.sh/algo/api/v3/user/status?Encode=1
```

`Encode=1` 参数表示请求体使用 COSYENC1 加密格式。

### 10.3 关键请求头

| 请求头 | 格式 | 说明 |
|--------|------|------|
| `cosy-machineid` | UUID v4 格式，如 `50485058-4c35-472d-8634-526d5048502d` | 由序列号派生（与 §2 key 派生算法相同） |
| `cosy-machinetoken` | URL-safe base64，约 66 字节随机数据，如 `P1gATgF2Esttw0GiS_RWQtskrohEnwZJ5XQo7KN-...` | 机器身份凭证 |
| `signature` | 32-byte hex，如 `9c297b85c8c7fbbdb4fc037eb1a2e243` | 请求签名 |

**`cosy-machineid` 与 key 派生的关联：**

`cosy-machineid` 的值正是 §2 中 UUID v4 格式序列号的**完整形式**（而 auth 文件 key 只取前 16 字节）：

```
序列号 hex:    504850584c3537463452...
完整 UUID:     50485058-4c35-472d-8634-526d5048502d  ← cosy-machineid
Auth key 取前16: 50485058-4c35-47                    ← AES key
```

### 10.4 加密请求体样例

请求体为 264 字节的自定义 Base64 字符串，形如：

```
lLf*xoBrxoKhDSFzaOFONOF^Pgf*l...
```

已成功解码部分请求体，明文包含字段：
- `userId`
- `personalToken`
- `securityOauthToken`
- `refreshToken`
- `needRefresh: false`

### 10.5 auth 文件二进制结构分析

```
~/.qoder/.auth/user 文件结构：
  1132 字节（标准 base64 编码）
  → base64 decode → 848 字节二进制密文
  → 848 = 53 × 16（AES 块大小的整数倍，符合 AES-CBC 结构）
```

**关于 IV 的历史注释：** 早期分析曾认为文件头 16 字节（`f219fd5014bad885b093f44...`）是 IV，后经逆向确认 IV 为硬编码常量（§3），与文件内容无关。
