/**
 * Frida hook script for qodercli - Improved version
 * 
 * Goals:
 *   1. Intercept ALL HTTP requests made by qodercli
 *   2. Extract full plaintext: URL, headers, body
 *   3. Optionally modify requests on-the-fly
 *
 * This version targets Go's net/http package which qodercli uses for all HTTP calls.
 * Hooking at the HTTP layer is more stable than hooking custom encrypt/decrypt functions.
 *
 * Usage:
 *   frida -f ~/.qoder/bin/qodercli/qodercli-0.1.38 -l frida-intercept-http.js -- -m "hello"
 *   Or attach to running:
 *   frida -n qodercli-0.1.38 -l frida-intercept-http.js
 */

// ── Go Runtime Helpers ───────────────────────────────────────────────────────

/**
 * Read a Go string from memory.
 * Go string header: { data *byte, len int64 }
 * On arm64: 8 bytes pointer + 8 bytes length
 */
function readGoString(addr) {
    const ptr = addr.readPointer();
    const len = addr.add(8).readU64().toNumber();
    if (len === 0) return '';
    return ptr.readUtf8String(len);
}

/**
 * Read a Go slice from memory.
 * Go slice header: { array *T, len int64, cap int64 }
 */
function readGoSlice(addr) {
    const arrayPtr = addr.readPointer();
    const len = addr.add(8).readU64().toNumber();
    if (len === 0) return new Uint8Array(0);
    return new Uint8Array(arrayPtr.readByteArray(len));
}

/**
 * Dump bytes as hex string
 */
function hexDump(bytes, maxLen) {
    maxLen = maxLen || bytes.length;
    let result = '';
    for (let i = 0; i < Math.min(maxLen, bytes.length); i++) {
        if (i > 0 && i % 16 === 0) result += '\n';
        result += bytes[i].toString(16).padStart(2, '0') + ' ';
    }
    return result;
}

/**
 * Dump bytes as ASCII (printable only)
 */
function asciiDump(bytes, maxLen) {
    maxLen = maxLen || bytes.length;
    let result = '';
    for (let i = 0; i < Math.min(maxLen, bytes.length); i++) {
        const c = bytes[i];
        result += (c >= 32 && c <= 126) ? String.fromCharCode(c) : '.';
    }
    return result;
}

// ── Intercept Targets ────────────────────────────────────────────────────────

// Target 1: net/http.(*Client).do
// This is the core HTTP request function in Go's standard library.
// All HTTP calls (including the LLM API) flow through here.

// Target 2: net/http.NewRequest / net/http.NewRequestWithContext
// Hook at request construction time to see URL, headers, body before sending.

// Target 3: crypto/tls.Conn.Write (for HTTPS traffic analysis)
// Lower level - can see encrypted TLS records (not useful for plaintext)

// Target 4: Qoder's custom request builder (if any)
// Look for functions with "request", "build", "api" in name via symbol search

// ── Strategy: Hook io.ReadCloser.Read on request body ────────────────────────
// The request body is an io.ReadCloser interface. We can hook its Read method
// to capture the plaintext body as it's being read for sending.

// ── Strategy: Hook net/http.Request.Write ────────────────────────────────────
// This method serializes the HTTP request to the wire. 
// By the time this is called, we have the complete request ready.

function interceptHTTP() {
    console.log('[*] Searching for HTTP-related symbols...');
    
    // Enumerate all modules to find the main binary
    const modules = Process.enumerateModules();
    let mainModule = null;
    
    for (const mod of modules) {
        if (mod.name.includes('qodercli') || mod.path.includes('.qoder')) {
            mainModule = mod;
            break;
        }
    }
    
    if (!mainModule) {
        mainModule = modules[0];
    }
    
    console.log(`[*] Main module: ${mainModule.name} @ ${mainModule.base}`);
    
    // ── Approach 1: Scan for known HTTP function patterns in pclntab ─────────
    // Go binaries keep function names in the program counter line table.
    // We can search for functions matching patterns like:
    //   - net/http.(*Client).do
    //   - net/http.(*Request).Write
    //   - net/http.send
    //   - net/http.(*Transport).roundTrip
    
    // Use Frida's Module.enumerateSymbols to find exported symbols
    const httpSymbols = mainModule.enumerateSymbols().filter(s => 
        s.name.includes('net/http') && 
        (s.name.includes('do') || s.name.includes('Write') || s.name.includes('send') || s.name.includes('RoundTrip'))
    );
    
    console.log(`[*] Found ${httpSymbols.length} HTTP-related symbols`);
    
    // Print first few for debugging
    for (let i = 0; i < Math.min(10, httpSymbols.length); i++) {
        console.log(`  ${httpSymbols[i].name} @ ${httpSymbols[i].address}`);
    }
    
    // ── Approach 2: Hook specific known functions ────────────────────────────
    
    // net/http.(*Client).do
    // Signature: func (c *Client) do(req *Request) (resp *Response, err error)
    // The *Request contains: Method, URL, Header, Body
    
    // net/http.(*Request).Write
    // Signature: func (r *Request) Write(w io.Writer) error
    // This writes the complete HTTP request to the wire
    
    // For Go 1.24 arm64, the calling convention uses registers x0-xN
    // Request struct layout (approximate, from Go src/net/http/request.go):
    //   Method   string  // offset 0
    //   URL      *url.URL // offset 16
    //   Header   Header   // offset 24
    //   Body     io.ReadCloser // offset 48
    //   ...
    
    // We need to find the actual offsets by analyzing the binary or using debug info
    
    // ── Approach 3: Hook at the socket/TCP layer ─────────────────────────────
    // If HTTP-level hooks fail, we can hook net.(*TCPConn).Write
    // This gives us the raw bytes being sent (after TLS encryption for HTTPS)
    // But for HTTP (non-TLS) it would show plaintext
    
    // ── Approach 4: Hook qodercli's API client directly ─────────────────────
    // Search for functions with "api", "chat", "completion", "llm" in name
    const apiSymbols = mainModule.enumerateSymbols().filter(s =>
        s.name.toLowerCase().includes('api') ||
        s.name.toLowerCase().includes('chat') ||
        s.name.toLowerCase().includes('completion') ||
        s.name.toLowerCase().includes('llm') ||
        s.name.toLowerCase().includes('request')
    );
    
    console.log(`\n[*] Found ${apiSymbols.length} API-related symbols`);
    for (let i = 0; i < Math.min(20, apiSymbols.length); i++) {
        console.log(`  ${apiSymbols[i].name}`);
    }
}

// ── Alternative: Hook at known offset from reverse engineering ───────────────

// From the existing reverse engineering docs, we know:
// - buildRequest is at offset 0x428240 in qodercli-0.1.38
// - This function builds the HTTP request before sending
// - We can hook it to extract the request details

const BUILD_REQUEST_OFF = 0x428240;

function hookBuildRequest() {
    const modules = Process.enumerateModules();
    let baseAddr = null;
    
    for (const mod of modules) {
        if (mod.name.includes('qodercli') || mod.path.includes('.qoder')) {
            baseAddr = mod.base;
            break;
        }
    }
    
    if (!baseAddr) {
        console.log('[!] Could not find qodercli module');
        return;
    }
    
    const buildRequestAddr = baseAddr.add(BUILD_REQUEST_OFF);
    console.log(`[*] Hooking buildRequest @ ${buildRequestAddr}`);
    
    try {
        Interceptor.attach(buildRequestAddr, {
            onEnter: function(args) {
                console.log('\n═══════════════════════════════════════════');
                console.log('[buildRequest] ENTER');
                console.log('═══════════════════════════════════════════');
                
                // Print all registers for analysis
                for (let i = 0; i < 8; i++) {
                    console.log(`  x${i} = ${args[i]}`);
                }
                
                // Try to interpret args as request struct fields
                // Based on Go struct layout, try common offsets
                const structPtr = args[0];
                
                // Try reading potential string fields at various offsets
                for (let offset = 0; offset < 0x100; offset += 16) {
                    try {
                        const strAddr = structPtr.add(offset);
                        const str = readGoString(strAddr);
                        if (str.length > 0 && str.length < 200 && str.startsWith('http')) {
                            console.log(`  [offset 0x${offset.toString(16)}] URL: ${str}`);
                        } else if (str.length > 0 && str.length < 50 && 
                                   (str === 'POST' || str === 'GET' || str === 'PUT')) {
                            console.log(`  [offset 0x${offset.toString(16)}] Method: ${str}`);
                        }
                    } catch(e) {
                        // Invalid memory access, skip
                    }
                }
                
                this.structPtr = structPtr;
                this.args = args.map(a => a.toString());
            },
            
            onLeave: function(retval) {
                console.log(`[buildRequest] LEAVE, retval = ${retval}`);
                console.log('═══════════════════════════════════════════\n');
            }
        });
        
        console.log('[+] buildRequest hook installed');
    } catch(e) {
        console.log(`[!] Failed to hook buildRequest: ${e.message}`);
    }
}

// ── Memory scanning for the alphabet ─────────────────────────────────────────

// The custom base64 alphabet is at offset 0x20d5720 in the binary
// We can read it directly from the loaded module

const ALPHABET_OFF = 0x20d5720;
const ALPHABET_LEN = 64;

function extractAlphabet() {
    const modules = Process.enumerateModules();
    let baseAddr = null;
    
    for (const mod of modules) {
        if (mod.name.includes('qodercli') || mod.path.includes('.qoder')) {
            baseAddr = mod.base;
            break;
        }
    }
    
    if (!baseAddr) {
        console.log('[!] Could not find qodercli module');
        return null;
    }
    
    const alphabetAddr = baseAddr.add(ALPHABET_OFF);
    
    try {
        const alphabet = alphabetAddr.readUtf8String(ALPHABET_LEN);
        console.log(`[*] Custom base64 alphabet: ${alphabet}`);
        return alphabet;
    } catch(e) {
        console.log(`[!] Failed to read alphabet: ${e.message}`);
        return null;
    }
}

// ── Hook the encoding function to see the full pipeline ──────────────────────

// If we can hook the function that applies the custom base64 encoding,
// we can capture:
// 1. The plaintext JSON before encoding
// 2. The encoded output
// This gives us the complete request body

// Known from reverse engineering:
// - The encoding uses a custom alphabet substitution
// - The plaintext is JSON matching OpenAI-compatible format
// - No actual AES encryption is applied to the body (despite the COSYENC1 prefix)

// ── Main Entry Point ─────────────────────────────────────────────────────────

(function main() {
    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║   Qoder CLI Frida Interceptor - Improved     ║');
    console.log('╚═══════════════════════════════════════════════╝');
    console.log(`[*] PID: ${Process.id}`);
    console.log(`[*] Arch: ${Process.arch}`);
    console.log(`[*] Platform: ${Process.platform}`);
    console.log('');
    
    // Step 1: Extract the custom alphabet from memory
    console.log('[*] Step 1: Extracting custom base64 alphabet...');
    const alphabet = extractAlphabet();
    if (alphabet) {
        console.log(`[+] Alphabet confirmed: ${alphabet}`);
    } else {
        console.log('[!] Could not extract alphabet from known offset');
    }
    console.log('');
    
    // Step 2: Scan for HTTP/API symbols
    console.log('[*] Step 2: Scanning for HTTP-related symbols...');
    interceptHTTP();
    console.log('');
    
    // Step 3: Hook buildRequest at known offset
    console.log('[*] Step 3: Hooking buildRequest...');
    hookBuildRequest();
    console.log('');
    
    console.log('[*] All hooks installed. Waiting for qodercli to make requests...');
    console.log('[*] Send a test message to trigger API calls.');
})();
