/**
 * Frida script v5: Hook after Go prologue is complete.
 * 
 * Go arm64 prologue pattern:
 *   [0] ldr x16, [x28, #0x10]     // load goroutine stack guard
 *   [1] sub x17, sp, #imm         // (optional) compute needed stack
 *   [2] cmp x17, x16  (or cmp sp, x16)
 *   [3] b.ls <grow>               // branch if stack needs growing
 *   [4] str x30, [sp, #-N]!  (or sub x20, sp, #M + stp x29, x30, [x20, #-8])
 *   [5] stur x29, [sp, #-8]       // save frame pointer
 *   [6] sub x29, sp, #8           // set up frame pointer
 *   [7+] actual function body - save args to stack
 *
 * Strategy: Hook at instruction [6] or [7] where prologue is done.
 * At this point original args have been saved to stack slots.
 * We need to read args from the correct stack offsets.
 * 
 * Alternative: Use the `str` instruction that saves args as our hook point.
 */

const BASE = Process.enumerateModules()[0].base;
console.log("[*] Module base: " + BASE);

function rebase(va) { return BASE.add(va - 0x100000000); }

function safeStr(p, len, max) {
    max = max || 500;
    if (len <= 0 || len > 100000 || p.isNull()) return null;
    try { return p.readUtf8String(Math.min(len, max)); } catch(e) { return null; }
}

function safeHex(p, len, max) {
    max = max || 256;
    if (len <= 0 || p.isNull()) return "";
    try {
        return Array.from(new Uint8Array(p.readByteArray(Math.min(len, max))))
            .map(b => b.toString(16).padStart(2,'0')).join('');
    } catch(e) { return "<err>"; }
}

function disasm(addr, count) {
    let pc = addr;
    const insns = [];
    for (let i = 0; i < count; i++) {
        const insn = Instruction.parse(pc);
        insns.push({ addr: pc, mnemonic: insn.mnemonic, opStr: insn.opStr, next: insn.next });
        pc = insn.next;
    }
    return insns;
}

// Hook strategy: find the first instruction after the prologue 
// (after sub x29, sp, #8 or after the stp/stur/sub sequence)
// that stores an argument register to stack
function hookAfterPrologue(name, va, nSkip, cb) {
    const addr = rebase(va);
    const insns = disasm(addr, 12);
    
    // Print disassembly
    console.log(`\n  ${name} disasm:`);
    insns.forEach((ins, i) => {
        console.log(`    [${i}] ${ins.addr}: ${ins.mnemonic} ${ins.opStr}`);
    });
    
    // Hook at instruction nSkip (after prologue)
    const hookAddr = insns[nSkip].addr;
    try {
        Interceptor.attach(hookAddr, {
            onEnter: function() { cb(this.context); }
        });
        console.log(`  [✓] ${name} @ [${nSkip}] ${hookAddr}`);
        return true;
    } catch(e) {
        console.log(`  [✗] ${name} @ [${nSkip}]: ${e.message}`);
        // Try next instruction
        const alt = insns[nSkip + 1].addr;
        try {
            Interceptor.attach(alt, {
                onEnter: function() { cb(this.context); }
            });
            console.log(`  [✓] ${name} @ [${nSkip+1}] ${alt}`);
            return true;
        } catch(e2) {
            console.log(`  [✗] ${name}: all failed`);
            return false;
        }
    }
}

// ============================================================
// RsaEncrypt: prologue = [0]ldr [1]cmp [2]b.ls [3]str [4]stur [5]sub
// After prologue, args are in x0-x4 or saved to stack
// Hook at [6] — first body instruction
// ============================================================
hookAfterPrologue("RsaEncrypt", 0x100380cb0, 6, function(ctx) {
    // After prologue, original x0-x4 may be saved to stack
    // But Go ABI often keeps args in regs through prologue
    // Let's try both registers and stack
    
    console.log("\n" + "█".repeat(60));
    console.log("[RsaEncrypt]");
    
    // Try registers first
    for (let i = 0; i <= 5; i++) {
        const v = ctx['x' + i];
        const s = safeStr(v, 200);
        const isLen = v.toInt32() > 0 && v.toInt32() < 10000;
        console.log(`  x${i}=${v}${s ? ' → "'+s.substring(0,100)+'"' : ''}${isLen ? ' (int='+v.toInt32()+')' : ''}`);
    }
    
    // Read from stack (fp-relative)
    const fp = ctx.x29;
    const sp = ctx.sp;
    console.log(`  sp=${sp} fp(x29)=${fp}`);
    
    // Dump stack frame
    for (let off = 0; off <= 64; off += 8) {
        try {
            const v = sp.add(off).readPointer();
            const s = safeStr(v, 100);
            if (s && s.length > 3) console.log(`  [sp+${off}]: "${s.substring(0, 100)}"`);
        } catch(e) {}
    }
    
    console.log("█".repeat(60));
});

// ============================================================
// Md5Encode: [0]ldr [1]sub [2]cmp [3]b.ls [4]sub(x20) [5]stp [6]mov(fp)
// Prologue is longer for functions with sub x20
// Hook at [7]
// ============================================================
hookAfterPrologue("Md5Encode", 0x100380f70, 7, function(ctx) {
    console.log("\n" + "▓".repeat(60));
    console.log("[Md5Encode]");
    for (let i = 0; i <= 4; i++) {
        const v = ctx['x' + i];
        const s = safeStr(v, 2000);
        const isLen = v.toInt32() > 0 && v.toInt32() < 100000;
        console.log(`  x${i}=${v}${s ? ' str="'+s.substring(0,500)+'"' : ''}${isLen ? ' int='+v.toInt32() : ''}`);
    }
    
    // Check x20 (new stack base for some Go functions)
    const x20 = ctx.x20;
    console.log(`  x20=${x20}`);
    
    // Args may be saved at sp+offset or x20+offset
    const sp = ctx.sp;
    for (let off = 0; off <= 80; off += 8) {
        try {
            const v = sp.add(off).readPointer();
            const s = safeStr(v, 500);
            if (s && s.length > 3) console.log(`  [sp+${off}]: "${s.substring(0, 200)}"`);
        } catch(e) {}
    }
    
    console.log("▓".repeat(60));
});

// ============================================================
// AesEncryptWithBase64: [0]ldr [1]sub [2]cmp [3]b.ls [4]str [5]stur [6]sub
// Hook at [7]
// ============================================================
hookAfterPrologue("AesEncrypt", 0x1003809d0, 7, function(ctx) {
    console.log("\n" + "░".repeat(60));
    console.log("[AesEncrypt]");
    for (let i = 0; i <= 6; i++) {
        const v = ctx['x' + i];
        const s = safeStr(v, 500);
        const isLen = v.toInt32() > 0 && v.toInt32() < 10000;
        console.log(`  x${i}=${v}${s ? ' str="'+s.substring(0,200)+'"' : ''}${isLen ? ' int='+v.toInt32() : ''}`);
    }
    console.log("░".repeat(60));
});

// ============================================================
// addBigModelSignatureHeaders: [0]ldr [1]sub [2]cmp [3]b.ls [4]str [5]stur [6]sub
// Hook at [7]
// ============================================================
hookAfterPrologue("addBigModelSigHdrs", 0x100422b70, 7, function(ctx) {
    console.log("\n" + "★".repeat(60));
    console.log("[addBigModelSignatureHeaders]");
    for (let i = 0; i <= 8; i++) {
        const v = ctx['x' + i];
        const s = safeStr(v, 200);
        console.log(`  x${i}=${v}${s ? ' → "'+s.substring(0,100)+'"' : ''}`);
    }
    console.log("★".repeat(60));
});

// ============================================================
// addBigModelAuthorizationHeaders: longer prologue with sub x20
// [0]ldr [1]sub [2]cmp [3]b.ls [4]sub(x20) [5]stp [6]mov
// Hook at [7]
// ============================================================
hookAfterPrologue("addBigModelAuthHdrs", 0x100422eb0, 7, function(ctx) {
    console.log("\n" + "◆".repeat(60));
    console.log("[addBigModelAuthorizationHeaders]");
    for (let i = 0; i <= 10; i++) {
        const v = ctx['x' + i];
        const s = safeStr(v, 200);
        console.log(`  x${i}=${v}${s ? ' → "'+s.substring(0,150)+'"' : ''}`);
    }
    // x20 is the adjusted stack pointer in extended prologues
    console.log(`  x20=${ctx.x20}`);
    // Stack dump
    const sp = ctx.sp;
    for (let off = 0; off <= 160; off += 8) {
        try {
            const v = sp.add(off).readPointer();
            const s = safeStr(v, 200);
            if (s && s.length > 3) console.log(`  [sp+${off}]: "${s.substring(0, 150)}"`);
        } catch(e) {}
    }
    console.log("◆".repeat(60));
});

// ============================================================
// getAuthSignature
// ============================================================
hookAfterPrologue("getAuthSig", 0x1004193b0, 7, function(ctx) {
    console.log("\n" + "►".repeat(60));
    console.log("[getAuthSignature]");
    for (let i = 0; i <= 4; i++) {
        const v = ctx['x' + i];
        const s = safeStr(v, 200);
        console.log(`  x${i}=${v}${s ? ' → "'+s.substring(0,150)+'"' : ''}`);
    }
    // Try dereferencing receiver (x0) to read struct fields
    try {
        const recv = ctx.x0;
        for (let off = 0; off < 128; off += 8) {
            const p = recv.add(off).readPointer();
            const s = safeStr(p, 200);
            if (s && s.length > 3) console.log(`  recv+${off}: "${s.substring(0, 150)}"`);
        }
    } catch(e) {}
    console.log("►".repeat(60));
});

// XxHash
hookAfterPrologue("XxHash", 0x100381140, 7, function(ctx) {
    console.log("\n[XxHash]");
    for (let i = 0; i <= 2; i++) {
        const v = ctx['x' + i];
        const s = safeStr(v, 500);
        console.log(`  x${i}=${v}${s ? ' → "'+s.substring(0,200)+'"' : ''} int=${v.toInt32()}`);
    }
});

// encryptParam
hookAfterPrologue("encryptParam", 0x1003b3a90, 7, function(ctx) {
    console.log("\n[encryptParam]");
    for (let i = 0; i <= 4; i++) {
        const v = ctx['x' + i];
        const s = safeStr(v, 500);
        console.log(`  x${i}=${v}${s ? ' → "'+s.substring(0,200)+'"' : ''} int=${v.toInt32()}`);
    }
});

console.log("\n[*] Ready.\n");
