/**
 * frida-hook-http.js
 *
 * 目标：捕获 qodercli 发出的完整 HTTP 请求，包括：
 *   - Authorization header
 *   - 请求 URL
 *   - 请求 body（custom base64 编码前的内容）
 *
 * 策略：
 *   1. 通过 pclntab 扫描找 net/http.(*Transport).roundTrip 地址
 *   2. Hook Go 的 crypto/tls Write 来捕获原始 TLS 明文
 *   3. Hook net/http.(*Request).write 来捕获 header
 *
 * 使用：
 *   frida -f ~/.qoder/bin/qodercli/qodercli-0.1.38 \
 *     -l /tmp/frida-hook-http.js \
 *     -- -p "QODER_INJECT_P" --max-turns 1
 */

// ===== 已知 file offsets (qodercli-0.1.38) =====
// 通过 pclntab 扫描确认的地址：
const KNOWN_OFFSETS = {
    EncryptBody:    0xc76a00,
    buildRequest:   0x428240,
    shouldEncrypt:  0x428a70,
    NewCipher:      0x1b9230,
    CreateUserMsg:  0x867550,
};

// ===== 主模块基地址 =====
const mods = Process.enumerateModules();
let BASE = ptr(0);
for (const m of mods) {
    if (m.name.includes('qodercli')) { BASE = m.base; break; }
}
if (BASE.equals(ptr(0))) BASE = mods[0].base;
console.log('[http-hook] base=' + BASE + ' module=' + mods[0].name);

// ===== pclntab 扫描：找 net/http 相关函数 =====
function scanPclntab(targetFuncs) {
    const results = {};
    // pclntab magic: Go 1.20+ = 0xFFFFFAFF or 0xFFFFFFFA
    const ranges = Process.enumerateRanges('r--');
    for (const r of ranges) {
        if (r.size < 0x100000) continue;
        try {
            // 搜索 pclntab magic
            const magic1 = Memory.scanSync(r.base, Math.min(r.size, 0x1000000), 'ff fa ff ff');
            const magic2 = Memory.scanSync(r.base, Math.min(r.size, 0x1000000), 'fa ff ff ff');
            const magics = [...magic1, ...magic2];
            for (const hit of magics) {
                const pclntab = hit.address;
                // pclntab header: magic(4) + 0x00 0x00 + quantum(1) + ptrsize(1) + nfunc(8)
                const quantum = pclntab.add(6).readU8();
                const ptrsize = pclntab.add(7).readU8();
                if (ptrsize !== 8) continue; // 只处理 64-bit
                const nfunc = pclntab.add(8).readU64().toNumber();
                if (nfunc < 100 || nfunc > 500000) continue;
                console.log('[pclntab] found @ ' + pclntab + ' nfunc=' + nfunc + ' quantum=' + quantum);

                // 函数表在 pclntab+8+8*2 = pclntab+24 开始（Go 1.18+）
                // 实际结构较复杂，我们搜索函数名字符串
                const tableStart = pclntab.add(8 + 8 + 8); // skip header
                for (let i = 0; i < Math.min(nfunc, 100000); i++) {
                    try {
                        const entry = tableStart.add(i * 16); // Go 1.18 func table entry size
                        const pc = entry.readU64().toNumber();
                        if (pc < BASE.toUInt32() || pc > BASE.toUInt32() + 0x10000000) continue;
                    } catch(e) { break; }
                }
                break;
            }
        } catch(e) {}
    }
    return results;
}

// ===== 更简单的方法：搜索函数名字符串 =====
function findFuncByNameScan(funcName) {
    const nameBytes = funcName.split('').map(c => c.charCodeAt(0).toString(16).padStart(2,'0')).join(' ');
    const results = [];
    for (const r of Process.enumerateRanges('r--')) {
        if (r.size < 1024) continue;
        try {
            const hits = Memory.scanSync(r.base, Math.min(r.size, 0x4000000), nameBytes);
            for (const h of hits) {
                // 验证：前后有 null 或特定字节
                const before = h.address.sub(1).readU8();
                const after = h.address.add(funcName.length).readU8();
                if (before === funcName.length && after === 0) {
                    results.push(h.address);
                }
            }
        } catch(e) {}
    }
    return results;
}

// ===== Hook: 捕获 Authorization header =====
// 方案1：在 shouldEncryptBody 处捕获 key 和 URL
Interceptor.attach(BASE.add(KNOWN_OFFSETS.shouldEncrypt), {
    onEnter: function(args) {
        // x0=key.ptr, x1=key.len
        const keyLen = args[1].toInt32();
        const urlPtr = args[2];
        const urlLen = args[3].toInt32();

        let urlStr = '';
        if (urlLen > 0 && urlLen < 2000) {
            try { urlStr = Memory.readUtf8String(urlPtr, urlLen); } catch(e) {}
        }

        if (keyLen === 32) {
            try {
                const keyBytes = Memory.readByteArray(args[0], 32);
                const keyHex = Array.from(new Uint8Array(keyBytes)).map(b => b.toString(16).padStart(2,'0')).join('');
                console.log('[shouldEncrypt] key=' + keyHex);
            } catch(e) {}
        }
        console.log('[shouldEncrypt] url=' + urlStr.slice(0, 200));
    },
    onLeave: function(ret) {
        console.log('[shouldEncrypt] -> ' + ret.toInt32());
    }
});

// 方案2：Hook EncryptBody，捕获加密前明文
Interceptor.attach(BASE.add(KNOWN_OFFSETS.EncryptBody), {
    onEnter: function(args) {
        console.log('\n[EncryptBody] called x0=' + args[0] + ' x1=' + args[1] + ' x2=' + args[2] + ' x3=' + args[3]);
        // 尝试不同 arg 解读：
        // Go arm64 register calling convention
        // args[0-7] → x0-x7
        for (let i = 0; i < 8; i++) {
            try {
                const v = args[i];
                const n = v.toInt32();
                if (n > 0 && n < 1024 * 1024) {
                    // 尝试作为 ptr 读取
                    try {
                        const s = Memory.readUtf8String(v, Math.min(n, 200));
                        if (s && s.length > 4) {
                            console.log('[EncryptBody] arg[' + i + '] as str len=' + n + ': ' + s.slice(0, 100));
                        }
                    } catch(e2) {}
                }
            } catch(e) {}
        }

        // 尝试读 x0 作为 slice ptr（data）
        try {
            const dataPtr = args[0];
            const dataLen = args[1].toInt32();
            if (dataLen > 0 && dataLen < 100000) {
                const data = Memory.readUtf8String(dataPtr, Math.min(dataLen, 500));
                console.log('[EncryptBody] data[0:500]=' + data);
            }
        } catch(e) {}

        this.savedArgs = [args[0], args[1], args[2], args[3]];
    },
    onLeave: function(ret) {
        console.log('[EncryptBody] returned x0=' + ret);
    }
});

// 方案3：Hook NewCipher，捕获 AES key
Interceptor.attach(BASE.add(KNOWN_OFFSETS.NewCipher), {
    onEnter: function(args) {
        const keyPtr = args[0];
        const keyLen = args[1].toInt32();
        if (keyLen >= 16 && keyLen <= 32) {
            try {
                const keyBytes = Memory.readByteArray(keyPtr, keyLen);
                const keyHex = Array.from(new Uint8Array(keyBytes)).map(b => b.toString(16).padStart(2,'0')).join('');
                console.log('\n[NewCipher] AES key (' + keyLen + ' bytes): ' + keyHex);
            } catch(e) {
                console.log('[NewCipher] failed to read key: ' + e);
            }
        }
    }
});

// ===== 方案4：扫描内存中的 Authorization header =====
// 在 CreateUserMessage hook 之后扫描，寻找 auth token
Interceptor.attach(BASE.add(KNOWN_OFFSETS.CreateUserMsg), {
    onEnter: function(args) {
        // 扫描所有可读内存中的 "Authorization" 字符串
        const authPat = '41 75 74 68 6f 72 69 7a 61 74 69 6f 6e 3a 20'; // "Authorization: "
        const bearerPat = '42 65 61 72 65 72 20'; // "Bearer "
        console.log('\n[CreateUserMsg] scanning for Authorization headers...');
        let found = 0;
        for (const r of Process.enumerateRanges('r--')) {
            if (r.size < 64 || r.size > 200 * 1024 * 1024) continue;
            try {
                const hits = Memory.scanSync(r.base, Math.min(r.size, 50 * 1024 * 1024), authPat);
                for (const h of hits) {
                    try {
                        const s = Memory.readUtf8String(h.address, 200);
                        console.log('[Auth found] @ ' + h.address + ': ' + s.slice(0, 150));
                        found++;
                        if (found >= 5) break;
                    } catch(e) {}
                }
                if (found >= 5) break;
            } catch(e) {}
        }
        // 也扫描 rw- 内存
        if (found === 0) {
            for (const r of Process.enumerateRanges('rw-')) {
                if (r.size < 64 || r.size > 50 * 1024 * 1024) continue;
                try {
                    const hits = Memory.scanSync(r.base, r.size, authPat);
                    for (const h of hits) {
                        try {
                            const s = Memory.readUtf8String(h.address, 300);
                            console.log('[Auth rw found] @ ' + h.address + ': ' + s.slice(0, 200));
                            found++;
                            if (found >= 10) break;
                        } catch(e) {}
                    }
                } catch(e) {}
            }
        }
        console.log('[CreateUserMsg] auth scan done, found=' + found);
    }
});

// ===== 方案5：尝试找 net/http roundTrip 或 writeHeader =====
// 在运行时搜索函数名（通过 funcdata section）
(function tryFindHttpFuncs() {
    const targets = [
        'net/http.(*Transport).roundTrip',
        'net/http.(*Request).write',
        'net/http.(*headerWriteRequest)',
        'net/http.(*persistConn).writeRequest',
        'crypto/tls.(*Conn).Write',
        'net/http.(*Request).Header.Set',
    ];

    // 搜索函数名字符串在只读段
    for (const name of targets) {
        const nameBytes = Array.from(name).map(c => c.charCodeAt(0).toString(16).padStart(2,'0')).join(' ');
        for (const r of Process.enumerateRanges('r--')) {
            if (r.size < 1024) continue;
            try {
                const hits = Memory.scanSync(r.base, Math.min(r.size, 0x8000000), nameBytes);
                if (hits.length > 0) {
                    console.log('[func-scan] found "' + name + '" @ ' + hits[0].address);
                    // 在 pclntab 函数表中查找对应 PC
                    // 暂时只记录地址，供后续分析
                }
            } catch(e) {}
        }
    }
})();

console.log('[http-hook] All hooks attached. Run qodercli to capture...');
