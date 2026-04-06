/**
 * Frida hook script for qodercli EncryptBody
 *
 * 目标：拦截 AES-256-CBC 加密调用，提取：
 *   - AES key (32 bytes)
 *   - IV (16 bytes)  
 *   - 明文 plaintext
 *
 * 已知地址（qodercli-0.1.38 base offset，需加 ASLR slide）：
 *   EncryptBody     = 0x100c76a00  (file off = 0xc76a00)
 *   crypto/aes.NewCipher = 0x1001b9230  (file off = 0x1b9230)
 *   shouldEncryptBody = 0x100428a70  (file off = 0x428a70)
 *   buildRequest    = 0x100428240  (file off = 0x428240)
 *
 * 使用方法：
 *   frida -f ~/.qoder/bin/qodercli/qodercli-0.1.38 -l frida-hook-encrypt.js -- [args]
 *   或 attach to running process:
 *   frida -n qodercli-0.1.38 -l frida-hook-encrypt.js
 */

// 文件偏移（从 pclntab 和反汇编确认）
const ENCRYPT_BODY_OFF   = 0xc76a00;   // EncryptBody
const NEW_CIPHER_OFF     = 0x1b9230;   // crypto/aes.NewCipher
const BUILD_REQUEST_OFF  = 0x428240;   // buildRequest
const SHOULD_ENCRYPT_OFF = 0x428a70;   // shouldEncryptBody

// 自定义 Base64 字母表（已逆向确认）
const CUSTOM_ALPHA   = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function customB64Decode(s) {
    // 将 custom alphabet 转换为 standard base64，然后解码
    let standard = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '=') { standard += '='; continue; }
        const idx = CUSTOM_ALPHA.indexOf(c);
        if (idx < 0) continue;
        standard += STANDARD_BASE64[idx];
    }
    return atob(standard);
}

function dumpHex(buf, maxBytes) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const n = Math.min(maxBytes || 64, bytes.length);
    let hex = '';
    for (let i = 0; i < n; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
        if (i % 16 === 15) hex += '\n';
        else hex += ' ';
    }
    return hex;
}

function readGoSlice(ptr) {
    // Go slice header: {ptr *byte, len int, cap int}
    const dataPtr = ptr.readPointer();
    const len = ptr.add(8).readU64();
    return { dataPtr, len: len.toNumber() };
}

function readGoString(ptr) {
    // Go string header: {ptr *byte, len int}
    const dataPtr = ptr.readPointer();
    const len = ptr.add(8).readU64();
    return Memory.readUtf8String(dataPtr, len.toNumber());
}

// 等待模块加载
function waitForModule(name, callback) {
    const mod = Process.findModuleByName(name);
    if (mod) {
        callback(mod);
    } else {
        // 尝试直接使用 qodercli-0.1.38
        const mainMod = Process.enumerateModules()[0];
        console.log(`[*] Main module: ${mainMod.name} base=${mainMod.base}`);
        callback(mainMod);
    }
}

// Hook entry
(function main() {
    console.log('[*] Frida hook starting...');
    console.log(`[*] Process: ${Process.getCurrentThreadId()}`);

    // 获取主模块基地址
    const modules = Process.enumerateModules();
    let baseAddr = null;
    let moduleName = null;
    
    for (const mod of modules) {
        if (mod.name.includes('qodercli')) {
            baseAddr = mod.base;
            moduleName = mod.name;
            break;
        }
    }
    
    if (!baseAddr) {
        // fallback: 第一个模块
        baseAddr = modules[0].base;
        moduleName = modules[0].name;
    }
    
    console.log(`[*] Module: ${moduleName} @ ${baseAddr}`);

    // 计算运行时地址
    const encryptBodyAddr   = baseAddr.add(ENCRYPT_BODY_OFF);
    const newCipherAddr     = baseAddr.add(NEW_CIPHER_OFF);
    const buildRequestAddr  = baseAddr.add(BUILD_REQUEST_OFF);
    const shouldEncryptAddr = baseAddr.add(SHOULD_ENCRYPT_OFF);

    console.log(`[*] EncryptBody     @ ${encryptBodyAddr}`);
    console.log(`[*] NewCipher       @ ${newCipherAddr}`);
    console.log(`[*] buildRequest    @ ${buildRequestAddr}`);
    console.log(`[*] shouldEncrypt   @ ${shouldEncryptAddr}`);

    // === Hook 1: EncryptBody ===
    // Signature: func EncryptBody(data []byte, key *[32]byte, iv []byte, obj *X) (*Result, error)
    // arm64 calling convention (Go):
    //   x0 = data.ptr, x1 = data.len, x2 = data.cap
    //   Actually Go uses register-based: x0, x1, x2... for first N args
    //   For EncryptBody(data []byte, key [32]byte, ...):
    //   - data slice: x0=ptr, x1=len, x2=cap  (or via SP if > 8 args)
    //   Looking at disasm: str x0,[sp,#0x88] at +24, cmp x1,#0x20 at +36
    //   So: x0=?, x1=key_len(32), x2,x3,x4=other params
    //   Actually from +24: str x0,[sp,#0x88] and +36: cmp x1,#0x20
    //   x0 = some struct ptr, x1 = key length, x3,x4 = iv info
    try {
        Interceptor.attach(encryptBodyAddr, {
            onEnter: function(args) {
                console.log('\n[EncryptBody] CALLED');
                console.log(`  x0=${args[0]} x1=${args[1]} x2=${args[2]} x3=${args[3]} x4=${args[4]}`);
                
                // x1 should be 32 (key length)
                const keyLen = args[1].toInt32();
                console.log(`  key_len = ${keyLen}`);
                
                if (keyLen === 32) {
                    // x0 points to data (input buffer)
                    // Key must be at x0 or passed via other reg
                    // From disasm: str x0,[sp,#0x88] then bl NewCipher without loading x0 again
                    // So x0 = key pointer (32 bytes)
                    try {
                        const keyBytes = new Uint8Array(Memory.readByteArray(args[0], 32));
                        console.log(`  KEY (32 bytes): ${dumpHex(keyBytes, 32)}`);
                        this.key = keyBytes;
                    } catch(e) {
                        console.log(`  [!] Failed to read key: ${e}`);
                    }
                }
                
                // x3, x4 = IV info (from disasm: str x3,[sp,#0xa0], str x4,[sp,#0xa8])
                // IV is 16 bytes for AES-CBC
                try {
                    const ivPtr = args[3];
                    if (!ivPtr.isNull()) {
                        const ivBytes = new Uint8Array(Memory.readByteArray(ivPtr, 16));
                        console.log(`  IV (16 bytes): ${dumpHex(ivBytes, 16)}`);
                        this.iv = ivBytes;
                    }
                } catch(e) {
                    console.log(`  [!] Failed to read IV: ${e}`);
                }
                
                // Save sp for later reading
                this.sp = this.context.sp;
            },
            onLeave: function(retval) {
                console.log(`  [EncryptBody] returned: x0=${retval}`);
            }
        });
        console.log('[+] EncryptBody hook attached');
    } catch(e) {
        console.log(`[!] Failed to hook EncryptBody: ${e}`);
    }

    // === Hook 2: crypto/aes.NewCipher ===
    // Signature: func NewCipher(key []byte) (cipher.Block, error)
    // Go arm64: x0=key.ptr, x1=key.len, x2=key.cap
    try {
        Interceptor.attach(newCipherAddr, {
            onEnter: function(args) {
                console.log('\n[NewCipher] CALLED');
                const keyPtr = args[0];
                const keyLen = args[1].toInt32();
                console.log(`  key.ptr=${keyPtr} key.len=${keyLen}`);
                
                if (keyLen > 0 && keyLen <= 64) {
                    try {
                        const keyBytes = new Uint8Array(Memory.readByteArray(keyPtr, keyLen));
                        console.log(`  AES KEY (${keyLen} bytes):`);
                        console.log(`    hex: ${Buffer.from(keyBytes).toString('hex')}`);
                        console.log(`    dump: ${dumpHex(keyBytes, keyLen)}`);
                        this.capturedKey = Buffer.from(keyBytes).toString('hex');
                    } catch(e) {
                        console.log(`  [!] Failed to read key: ${e}`);
                    }
                }
            },
            onLeave: function(retval) {
                if (this.capturedKey) {
                    console.log(`  [NewCipher] key=${this.capturedKey} block=${retval}`);
                }
            }
        });
        console.log('[+] NewCipher hook attached');
    } catch(e) {
        console.log(`[!] Failed to hook NewCipher: ${e}`);
    }

    // === Hook 3: shouldEncryptBody ===
    // Signature: func shouldEncryptBody(key []byte, method string, url string) bool
    // x0=key.ptr, x1=key.len, x2=method.ptr, x3=method.len, x4=url.ptr... 
    // But from disasm at 0x100428a70:
    //   str x3,[sp,0x70], str x2,[sp,0x68], str x1,[sp,0x60], str x0,[sp,0x58]
    //   cmp x1, #0x20  <- checks key length
    // So: x0=key.ptr, x1=key.len, x2=url.ptr(?), x3=url.len(?)
    try {
        Interceptor.attach(shouldEncryptAddr, {
            onEnter: function(args) {
                const keyLen = args[1].toInt32();
                const urlPtr = args[2];
                const urlLen = args[3].toInt32();
                
                let urlStr = '';
                if (urlLen > 0 && urlLen < 500) {
                    try { urlStr = Memory.readUtf8String(urlPtr, urlLen); } catch(e) {}
                }
                
                console.log(`\n[shouldEncryptBody] key_len=${keyLen} url="${urlStr.slice(0, 100)}"`);
            },
            onLeave: function(retval) {
                console.log(`  -> should_encrypt=${retval.toInt32()}`);
            }
        });
        console.log('[+] shouldEncryptBody hook attached');
    } catch(e) {
        console.log(`[!] Failed to hook shouldEncryptBody: ${e}`);
    }

    // === Hook 4: buildRequest ===
    // To capture the full request being built
    try {
        Interceptor.attach(buildRequestAddr, {
            onEnter: function(args) {
                console.log(`\n[buildRequest] CALLED x0=${args[0]}`);
                // Try to read the request struct
                // From disasm: ldr x6,[x0,#0x58] (URL?), ldr x1,[x0,#0x60] (URL len?)
                try {
                    const structPtr = args[0];
                    const urlPtr = structPtr.add(0x58).readPointer();
                    const urlLen = structPtr.add(0x60).readU64().toNumber();
                    if (urlLen > 0 && urlLen < 500) {
                        const url = Memory.readUtf8String(urlPtr, urlLen);
                        console.log(`  URL: ${url}`);
                    }
                } catch(e) {}
            },
            onLeave: function(retval) {
                console.log(`  [buildRequest] returned`);
            }
        });
        console.log('[+] buildRequest hook attached');
    } catch(e) {
        console.log(`[!] Failed to hook buildRequest: ${e}`);
    }

    console.log('\n[*] All hooks attached, waiting for qodercli to make requests...\n');
})();
