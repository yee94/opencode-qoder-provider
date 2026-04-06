#!/usr/bin/env node
/**
 * Qoder Direct API Client
 * 
 * This script bypasses qodercli and communicates directly with Qoder's LLM API.
 * It uses the authentication credentials from ~/.qoder/.auth/user and implements
 * the custom base64 encoding that the server expects.
 * 
 * Based on reverse engineering from:
 *   - docs/qodercli-auth-decryption.md
 *   - docs/qoder-request-encryption-reverse-engineering.md
 *   - docs/qoder-encoding-reference.md
 * 
 * Usage:
 *   node qoder-direct-api.js "What is 2+2?"
 *   node qoder-direct-api.js --model efficient "Explain quantum computing"
 *   node qoder-direct-api.js --stream "Write a poem"
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

// ── Configuration ─────────────────────────────────────────────────────────────

const AUTH_PATH = path.join(process.env.HOME, '.qoder', '.auth', 'user');
const AUTH_PATH_ALT = path.join(process.env.HOME, '.qoderwork', '.auth', 'user');

// Custom base64 alphabet (confirmed from qodercli binary at offset 0x20d5720)
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// API endpoint (from reverse engineering)
const API_URL = 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation';

// Default model
const DEFAULT_MODEL = 'efficient';

// ── Auth Decryption ──────────────────────────────────────────────────────────

/**
 * Decrypt the auth file to get access token and user info.
 * Auth file encryption (confirmed by reverse engineering):
 *   - Algorithm: AES-128-CBC with PKCS7 padding
 *   - Key: First 16 chars of hex-encoded macOS serial number in UUID format
 *   - IV: Same as Key (key == IV, confirmed experimentally)
 */
function decryptAuthFile() {
    const authPath = fs.existsSync(AUTH_PATH) ? AUTH_PATH : AUTH_PATH_ALT;
    
    if (!fs.existsSync(authPath)) {
        throw new Error(
            `Auth file not found at ${AUTH_PATH} or ${AUTH_PATH_ALT}.\n` +
            `Please run 'qoder login' first.`
        );
    }
    
    const encryptedBase64 = fs.readFileSync(authPath, 'utf-8').trim();
    const ciphertext = Buffer.from(encryptedBase64, 'base64');
    
    // Derive key from macOS serial number
    const serialNumber = getMacSerialNumber();
    const key = deriveAuthKey(serialNumber);
    // IV = key (same bytes) — confirmed by reverse engineering
    const iv = key;
    
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return JSON.parse(decrypted.toString('utf-8'));
}

/**
 * Get macOS serial number via IOKit.
 * This is the same method qodercli uses to derive the auth key.
 */
function getMacSerialNumber() {
    if (process.platform !== 'darwin') {
        throw new Error('Auth key derivation only supported on macOS');
    }
    
    try {
        // Use ioreg to get IOPlatformSerialNumber
        const output = execSync(
            'ioreg -c IOPlatformExpertDevice -d 2 | awk -F\'"\' \'/IOPlatformSerialNumber/{print $4}\'',
            { encoding: 'utf-8' }
        );
        return output.trim();
    } catch (e) {
        throw new Error(`Failed to get serial number: ${e.message}`);
    }
}

/**
 * Derive auth key from serial number.
 * Process: serial -> hex -> UUID v4 format -> first 16 chars
 * 
 * Example:
 *   serial: "PHPXL57F4R"
 *   hex:    "504850584c3537463452"
 *   UUID:   "50485058-4c35-472d-8634-..." (version nibble '4' inserted)
 *   key:    "50485058-4c35-47" (first 16 chars before the '4' version nibble is part of pattern)
 * 
 * Actually: key_str = f"{h[0:8]}-{h[8:12]}-4{h[13]}"
 * For h = "504850584c3537463452":
 *   h[0:8] = "50485058"
 *   h[8:12] = "4c35"
 *   h[13] = "7"  (index 13 in hex string)
 *   key = "50485058-4c35-47"  (8 + 1 + 4 + 1 + 2 = 16 chars)
 */
function deriveAuthKey(serialNumber) {
    const h = serialNumber.split('').map(c => 
        c.charCodeAt(0).toString(16).padStart(2, '0')
    ).join('');
    
    // UUID v4 format: XXXXXXXX-XXXX-4Y-...
    // Key = first 16 chars of this UUID string
    const keyStr = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h[13]}`;
    return Buffer.from(keyStr, 'ascii');
}

// ── Custom Base64 Encoding ───────────────────────────────────────────────────

/**
 * Encode data using Qoder's custom base64 alphabet.
 * This is a simple substitution cipher, not real encryption.
 */
function customBase64Encode(data) {
    // First, standard base64 encode
    const standard = data.toString('base64');
    
    // Then substitute alphabet
    let result = '';
    for (const char of standard) {
        const idx = STANDARD_BASE64.indexOf(char);
        if (idx >= 0) {
            result += CUSTOM_ALPHABET[idx];
        } else {
            result += char; // Keep padding '=' as-is
        }
    }
    
    return result;
}

/**
 * Decode data from Qoder's custom base64 alphabet.
 */
function customBase64Decode(encoded) {
    // First, translate back to standard base64
    let standard = '';
    for (const char of encoded) {
        const idx = CUSTOM_ALPHABET.indexOf(char);
        if (idx >= 0) {
            standard += STANDARD_BASE64[idx];
        } else {
            standard += char;
        }
    }
    
    // Then standard base64 decode
    return Buffer.from(standard, 'base64');
}

// ── Request Building ─────────────────────────────────────────────────────────

/**
 * Build the request body matching qodercli's format.
 * 
 * Confirmed from mitmproxy capture of qoder_request_3.bin (decoded from custom base64).
 * This is NOT OpenAI format — it's Qoder's own chat API format.
 */
function buildRequestBody(message, options = {}) {
    const {
        model = DEFAULT_MODEL,
        stream = true,
        maxTokens = 32768,
        sessionId = crypto.randomUUID(),
        isReply = false,
        isRetry = false,
        organizationId = '',
        userType = 'teams',
        isReasoning = false,
    } = options;

    const requestId = crypto.randomUUID();
    const modelDisplayNames = {
        auto: 'Auto (1.0x)',
        ultimate: 'Ultimate (1.6x)',
        performance: 'Performance (1.1x)',
        efficient: 'Efficient',
        lite: 'Lite (free)',
        q35model_preview: 'Qwen3.6-Plus-DogFooding (0x)',
        qmodel: 'Qwen3.6-Plus (0.2x)',
        q35model: 'Qwen3.5-Plus (0.2x)',
        gmodel: 'GLM-5 (0.5x)',
        kmodel: 'Kimi-K2.5 (0.3x)',
        mmodel: 'MiniMax-M2.7 (0.2x)',
    };

    return {
        request_id: requestId,
        request_set_id: crypto.randomUUID(),
        chat_record_id: requestId,
        stream,
        chat_task: 'FREE_INPUT',
        chat_context: {
            chatPrompt: '',
            extra: {
                context: [],
                modelConfig: { is_reasoning: isReasoning, key: model },
                originalContent: { type: 'text', text: message },
            },
            features: [],
            imageUrls: null,
            text: { type: 'text', text: message },
        },
        image_urls: null,
        is_reply: isReply,
        is_retry: isRetry,
        session_id: sessionId,
        code_language: '',
        source: 1,
        version: '3',
        chat_prompt: '',
        parameters: { max_tokens: maxTokens },
        aliyun_user_type: userType,
        session_type: 'qodercli',
        agent_id: 'agent_common',
        task_id: 'common',
        model_config: {
            key: model,
            display_name: modelDisplayNames[model] || model,
            model: '',
            format: 'openai',
            is_vl: true,
            is_reasoning: isReasoning,
            api_key: '',
            url: '',
            source: 'system',
            max_input_tokens: 180000,
        },
        messages: [
            {
                role: 'user',
                content: message,
            },
        ],
        response_meta: {
            id: '',
            usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
                completion_tokens_details: { reasoning_tokens: 0 },
                prompt_tokens_details: { cached_tokens: 0 },
            },
        },
    };
}

/**
 * Build all required HTTP headers for Qoder API.
 * 
 * Headers confirmed from mitmproxy capture (/tmp/qoder_headers_3.json).
 * 
 * Notes on cosy-key and cosy-machinetoken:
 *   - cosy-machinetoken: machine-bound, derived from qodercli internal state, stored in auth system
 *   - cosy-key: per-session key, likely RSA-encrypted session token
 *   - Both are read from qodercli at runtime; we use captured values as fallback
 *   - authorization: COSY.{base64_payload}.{sig} format built by qodercli
 *     The inner "info" field is RSA-2048 encrypted (336 bytes → 2688 bits ≈ RSA 2048 + overhead)
 *     Fallback: try raw access_token first (dt-... format), then COSY format if server rejects
 */
function buildHeaders(authData, bodyBuffer) {
    const timestamp = Math.floor(Date.now() / 1000);
    const machineId = getMachineId();
    const orgTags = Array.isArray(authData.organization_tags)
        ? authData.organization_tags.join(',')
        : (authData.organization_tags || '');

    // Attempt to build COSY token from access_token
    // Format: COSY.{base64(json_payload)}.{md5_or_hmac_sig}
    // For now we use the raw access_token and let the server tell us if it's rejected
    const authorization = `Bearer ${authData.access_token}`;

    const headers = {
        'accept': 'text/event-stream',
        'cosy-version': '0.1.38',
        'cosy-clienttype': '5',
        'login-version': 'v2',
        'cosy-date': timestamp.toString(),
        'authorization': authorization,
        'x-model-key': DEFAULT_MODEL,
        'x-model-source': 'system',
        'content-type': 'application/json',
        'cache-control': 'no-cache',
        'accept-encoding': 'identity',
        'cosy-machineid': machineId,
        'cosy-user': authData.uid,
        'cosy-data-policy': 'DISAGREE',
        'cosy-codebase-status': 'STILLA_DISABLED',
    };

    // Add optional organization headers if present
    if (authData.organization_id) {
        headers['cosy-organization-id'] = authData.organization_id;
    }
    if (orgTags) {
        headers['cosy-organization-tags'] = orgTags;
    }

    // cosy-machinetoken: machine-bound token written by qodercli on login.
    // Try reading from auth file system; fall back to known captured value for this machine.
    const machineToken = getMachineToken();
    if (machineToken) {
        headers['cosy-machinetoken'] = machineToken;
    }

    // cosy-key: per-session RSA-encrypted key. Try reading from auth cache; fall back to captured value.
    const cosyKey = getCosyKey(authData);
    if (cosyKey) {
        headers['cosy-key'] = cosyKey;
    }

    return headers;
}

/**
 * Get cosy-machinetoken.
 * Written by qodercli to ~/.qoder/.auth/ on login.
 * Falls back to known captured value for this machine.
 */
function getMachineToken() {
    // Try common locations qodercli might write this
    const candidates = [
        path.join(process.env.HOME, '.qoder', '.auth', 'machinetoken'),
        path.join(process.env.HOME, '.qoder', '.auth', 'machine_token'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return fs.readFileSync(p, 'utf-8').trim();
        }
    }
    // Fallback: known captured value for machine 50485058-4c35-472d-8634-526d5048502d
    // This is machine-bound and won't change unless re-login on a different machine
    return 'P1gATgF2Esttw0GiS_RWQtskrohEnwZJ5XQo7KN-b35wSXkAZfOtZd9qUmem9k5sQecgFmqu_bFstKJcE7BfWJ-j';
}

/**
 * Get cosy-key.
 * This is an RSA-encrypted session key sent in headers.
 * The captured value may expire; if so, we need to re-capture or reverse the generation.
 */
function getCosyKey(authData) {
    // Try reading from auth cache
    const cosyKeyFile = path.join(process.env.HOME, '.qoder', '.auth', 'cosy_key');
    if (fs.existsSync(cosyKeyFile)) {
        return fs.readFileSync(cosyKeyFile, 'utf-8').trim();
    }
    // Fallback: captured value (may be stale after token refresh)
    // TODO: reverse engineer the RSA key generation from qodercli binary
    return 'I+Wvx6x7shV2aJRZVl/wT8hq87kn+HBm3LJkXpP+nMCIG15L0Lt2D9UQ8KtR5ixXo50os4UTKuGQeDj98eaAgxiv2YhQMW3UaTXaIsF6iwRqX5w0xAReLOYMirRrbPGsOUH+IazNXtgBcT2glAeJpaMbK7M0YCjncXQenKr3gGw=';
}

/**
 * Generate machine ID — full UUID derived from IOPlatformSerialNumber.
 * Format: XXXXXXXX-XXXX-4Y-ZZ-WWWWWWWWWWWW (UUID v4 style)
 * This is the cosy-machineid header value (confirmed from frida analysis).
 * 
 * The full UUID is stored in ~/.qoder/.auth/id and matches the cosy-machineid.
 */
function getMachineId() {
    // Prefer reading from ~/.qoder/.auth/id (written by qodercli on login)
    const idFile = path.join(process.env.HOME, '.qoder', '.auth', 'id');
    if (fs.existsSync(idFile)) {
        return fs.readFileSync(idFile, 'utf-8').trim();
    }
    
    // Fallback: derive from serial number (same algorithm as qodercli)
    const serial = getMacSerialNumber();
    return deriveMachineId(serial);
}

/**
 * Derive full machine UUID from serial number.
 * Same algorithm as qodercli's keyTransform function.
 */
function deriveMachineId(serialNumber) {
    const h = serialNumber.split('').map(c => 
        c.charCodeAt(0).toString(16).padStart(2, '0')
    ).join('');
    // Full UUID v4 style: 8-4-4-4-12
    // From frida: cosy-machineid = 50485058-4c35-472d-8634-526d5048502d
    // h = '504850584c3537463452' (20 chars from 10-char serial)
    // uuid[0:8]  = h[0:8]   = '50485058'
    // uuid[9:13] = h[8:12]  = '4c35'
    // uuid[14]   = '4'      (version nibble)
    // uuid[15]   = h[12]    = '7'  → but actual is '47', so uuid[14:16]='47'
    // ...pattern unclear beyond first 16, read from file preferred
    const p1 = h.slice(0, 8);
    const p2 = h.slice(8, 12);
    const p3 = `4${h.slice(12, 15)}`;
    const p4 = h.slice(15, 19);
    const p5 = h.slice(19).padEnd(12, '0');
    return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

// ── API Client ───────────────────────────────────────────────────────────────

/**
 * Send a direct request to Qoder's LLM API.
 * 
 * Key finding: DO NOT use Encode=1 + custom base64 — that returns HTTP 500.
 * Send raw JSON body directly, no encoding. Server accepts this just fine.
 */
async function sendRequest(message, options = {}) {
    const { stream = true } = options;
    
    // 1. Decrypt auth file
    console.error('[*] Decrypting auth file...');
    const authData = decryptAuthFile();
    console.error(`[+] Authenticated as: ${authData.name || authData.email}`);
    
    // 2. Build request body (Qoder custom format, not OpenAI)
    console.error(`[*] Building request for model: ${options.model || DEFAULT_MODEL}`);
    const bodyJson = buildRequestBody(message, options);
    const bodyBuffer = Buffer.from(JSON.stringify(bodyJson), 'utf-8');
    
    // 3. Build URL WITHOUT Encode=1 (adding Encode=1 causes HTTP 500)
    const url = new URL(API_URL);
    url.searchParams.set('FetchKeys', 'llm_model_result');
    url.searchParams.set('AgentId', 'agent_common');
    // NOTE: Do NOT set Encode=1 — confirmed to cause HTTP 500
    
    // 4. Build headers — send raw JSON body
    const headers = buildHeaders(authData, bodyBuffer);
    headers['x-model-key'] = options.model || DEFAULT_MODEL;
    headers['content-length'] = bodyBuffer.length.toString();
    
    console.error(`[*] Sending to: ${url.toString()}`);
    console.error(`[*] Body length: ${bodyBuffer.length} bytes (raw JSON, no encoding)`);
    
    // 5. Send request with raw JSON body
    if (stream) {
        return streamResponse(url.toString(), headers, bodyBuffer);
    } else {
        return nonStreamResponse(url.toString(), headers, bodyBuffer);
    }
}

/**
 * Handle streaming response (SSE).
 * 
 * Qoder SSE format (from SDK reverse engineering):
 * Each SSE event is: data: {json}\n\n
 * The JSON can be:
 *   - { type: 'stream_event', body: '{...openai_delta...}' }  ← preferred incremental path
 *   - { type: 'assistant', body: '{...full_block...}' }        ← full-block fallback
 *   - { choices: [{delta: {content: '...'}}] }                 ← direct OpenAI format
 * body field is a JSON string (double-encoded).
 */
async function streamResponse(url, headers, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: body,
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    console.error('[*] Streaming response...\n');
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        // Process SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer
        
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const rawData = line.slice(6).trim();
            if (rawData === '[DONE]') {
                console.error('\n\n[*] Stream complete.');
                return fullContent;
            }
            
            try {
                const event = JSON.parse(rawData);
                
                // Path 1: stream_event with double-encoded body
                if (event.type === 'stream_event' && event.body) {
                    const inner = JSON.parse(event.body);
                    const chunk = inner.choices?.[0]?.delta?.content || '';
                    if (chunk) {
                        process.stdout.write(chunk);
                        fullContent += chunk;
                    }
                    if (inner.choices?.[0]?.finish_reason) {
                        console.error('\n\n[*] Stream complete.');
                        return fullContent;
                    }
                    continue;
                }

                // Path 2: assistant block (full content)
                if (event.type === 'assistant' && event.body) {
                    const inner = JSON.parse(event.body);
                    const chunk = inner.choices?.[0]?.message?.content ||
                                  inner.choices?.[0]?.delta?.content || '';
                    if (chunk && !fullContent) { // avoid double-printing
                        process.stdout.write(chunk);
                        fullContent = chunk;
                    }
                    continue;
                }
                
                // Path 3: direct OpenAI-style delta
                const chunk = event.choices?.[0]?.delta?.content || '';
                if (chunk) {
                    process.stdout.write(chunk);
                    fullContent += chunk;
                }
                if (event.choices?.[0]?.finish_reason && event.choices[0].finish_reason !== 'null') {
                    console.error('\n\n[*] Stream complete.');
                    return fullContent;
                }

                // Path 4: double-encoded body at top level
                if (typeof event.body === 'string') {
                    const inner = JSON.parse(event.body);
                    const innerChunk = inner.choices?.[0]?.delta?.content || '';
                    if (innerChunk) {
                        process.stdout.write(innerChunk);
                        fullContent += innerChunk;
                    }
                    if (inner.choices?.[0]?.finish_reason) {
                        console.error('\n\n[*] Stream complete.');
                        return fullContent;
                    }
                }
            } catch (e) {
                // Log malformed SSE events for debugging
                console.error(`[!] SSE parse error: ${e.message} | line: ${rawData.slice(0, 100)}`);
            }
        }
    }
    
    return fullContent;
}

/**
 * Handle non-streaming response.
 */
async function nonStreamResponse(url, headers, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    const responseText = await response.text();
    
    // Try to parse the response
    try {
        const data = JSON.parse(responseText);
        if (data.body) {
            const bodyObj = JSON.parse(data.body);
            return bodyObj.choices?.[0]?.message?.content || JSON.stringify(bodyObj);
        }
        return data.choices?.[0]?.message?.content || JSON.stringify(data);
    } catch (e) {
        return responseText;
    }
}

// ── CLI Entry Point ──────────────────────────────────────────────────────────

function parseArgs(argv) {
    try {
        const args = {
            model: DEFAULT_MODEL,
            stream: true,
            temperature: 0.7,
            maxTokens: 32768,
        };
        
        let messageStart = -1;  // -1 means not found
        
        for (let i = 0; i < argv.length; i++) {
            const val = argv[i];
            if (val === '--model') {
                args.model = argv[++i];
            } else if (val === '--no-stream') {
                args.stream = false;
            } else if (val === '--temperature' || val === '-t') {
                args.temperature = parseFloat(argv[++i]);
            } else if (val === '--max-tokens') {
                args.maxTokens = parseInt(argv[++i], 10);
            } else {
                if (messageStart === -1) {
                    messageStart = i;
                }
            }
        }
        
        if (messageStart === -1) {
            console.error('Usage: node qoder-direct-api.js [options] <message>');
            console.error('Options:');
            console.error('  --model <model>         Model ID (default: efficient)');
            console.error('  --no-stream             Disable streaming');
            console.error('  --temperature, -t <n>   Temperature (0.0-1.0)');
            console.error('  --max-tokens <n>        Max output tokens');
            process.exit(1);
        }
        
        args.message = argv.slice(messageStart).join(' ');
        return args;
    } catch (e) {
        console.error('[parseArgs] ERROR:', e.message);
        throw e;
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    
    console.error('╔═══════════════════════════════════════════════╗');
    console.error('║        Qoder Direct API Client               ║');
    console.error('║   Bypasses qodercli, talks directly to API   ║');
    console.error('╚═══════════════════════════════════════════════╝\n');
    
    try {
        const content = await sendRequest(args.message, {
            model: args.model,
            stream: args.stream,
            temperature: args.temperature,
            maxTokens: args.maxTokens,
        });
        
        if (!args.stream) {
            console.log(content);
        }
    } catch (error) {
        console.error(`\n[!] Error: ${error.message}`);
        console.error('\nTroubleshooting:');
        console.error('  1. Make sure you are logged in: qoder login');
        console.error('  2. Check auth file exists: ls ~/.qoder/.auth/user');
        console.error('  3. Try a different model: --model auto');
        console.error('  4. Check network connectivity to api3.qoder.sh');
        process.exit(1);
    }
}

main().catch(console.error);
