/**
 * test-api-direct.mjs
 *
 * Direct API call to Qoder LLM, using fully reverse-engineered auth.
 * No external dependencies — pure Node.js built-ins.
 *
 * Usage:
 *   node scripts/test-api-direct.mjs
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL =
  'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation' +
  '?FetchKeys=llm_model_result&AgentId=agent_common';

const URL_PATH =
  '/algo/api/v2/service/pro/sse/agent_chat_generation';

const COSY_VERSION = '0.1.38';

// Captured info field (448 chars) — captured via Frida hook on GenerateAuthToken RET
// This field is static per machine (derived from encrypt_user_info / machineToken)
const CAPTURED_INFO =
  'xRMOk0JxP7WWZlhDzsY8PviH1VTvMI550lDuU09RcA1PdUteaOm+mEXPAwvlbi/zQPY5IJ44r8HX8tD2Gu4Hm9iq+9Ibcl8acFtzLf1NGogYlULi8eFj2u74uoTp7LNS4YCDJIQFifSkIMqsx0ARClX/DCBPj1Bi3LjABd8FbGGIgMI/E0UYftjAEE3CSZuQm+AyiKqkZhSrWbJWhvvcKf60XC8so1wfbB3IDYAI68D+esETCTIPnal8/PcR7BqwiV1mifcnsdf7H2Vzeu8GnAroCk/gs1R4HSQSSmfKPg3RAx7rdG+cQdvvq+HEB3gLDIvaMnMhN/FMiIJwumvh2dmkc0ukhQXioXTlKrEVh8ZGlAAEuqaT/JQ/noYbkTbcCW7PIuSRukpMYce8NFybYds/lfSmnzIx+wL6Cg/rwqAEAZLPpt2o6ev1Q9ogzc47';

// ---------------------------------------------------------------------------
// Step 1 — Read machineId from ~/.qoder/.auth/id
// ---------------------------------------------------------------------------

function readMachineId() {
  const idPath = path.join(os.homedir(), '.qoder', '.auth', 'id');
  try {
    return fs.readFileSync(idPath, 'utf8').trim();
  } catch (err) {
    throw new Error(`Failed to read machineId from ${idPath}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Step 2 — Decrypt ~/.qoder/shared_client/cache/user
// ---------------------------------------------------------------------------

function decryptUserCache(machineId) {
  const userCachePath = path.join(
    os.homedir(),
    '.qoder',
    'shared_client',
    'cache',
    'user'
  );

  let raw;
  try {
    raw = fs.readFileSync(userCachePath, 'utf8').trim();
  } catch (err) {
    throw new Error(`Failed to read user cache from ${userCachePath}: ${err.message}`);
  }

  // Key / IV = first 16 chars of machineId as ASCII bytes
  const keyStr = machineId.slice(0, 16);
  const key = Buffer.from(keyStr, 'ascii');
  const iv = key; // key === IV

  // The file is base64-encoded AES-128-CBC ciphertext
  const ciphertext = Buffer.from(raw, 'base64');

  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  try {
    return JSON.parse(decrypted.toString('utf8'));
  } catch (err) {
    throw new Error(`Failed to parse decrypted user cache as JSON: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Step 3 — Build COSY JWT
// ---------------------------------------------------------------------------

function buildCosyJwt(machineToken, timestamp) {
  const payload = {
    version: 'v1',
    requestId: crypto.randomUUID(),
    info: CAPTURED_INFO,
    cosyVersion: COSY_VERSION,
    ideVersion: '',
  };

  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');

  // sigInput = base64Payload \n machineToken \n timestamp \n (empty s4) \n urlPath
  const sigInput = `${base64Payload}\n${machineToken}\n${timestamp}\n\n${URL_PATH}`;
  const sig = crypto.createHash('md5').update(sigInput).digest('hex');

  return { jwt: `Bearer COSY.${base64Payload}.${sig}`, base64Payload };
}

// ---------------------------------------------------------------------------
// Step 4 — Build HTTP Signature headers
// ---------------------------------------------------------------------------

function buildHttpSigHeaders() {
  const date = new Date().toUTCString(); // RFC1123
  const httpSig = crypto
    .createHash('md5')
    .update(`cosy&d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==&${date}`)
    .digest('hex');
  return { date, httpSig };
}

// ---------------------------------------------------------------------------
// Step 5 — Build request body (copied from qoder-direct-api.js buildRequestBody)
// ---------------------------------------------------------------------------

function buildRequestBody(message, options = {}) {
  const {
    model = 'efficient',
    stream = true,
    maxTokens = 32768,
    sessionId = crypto.randomUUID(),
    isReply = false,
    isRetry = false,
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

// ---------------------------------------------------------------------------
// Step 6 — Stream the SSE response
// ---------------------------------------------------------------------------

function truncateForLog(value, maxLen = 20) {
  const s = String(value);
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…(${s.length} chars)`;
}

function printHeadersDebug(headers) {
  const sensitiveKeys = new Set([
    'authorization',
    'cosy-key',
    'cosy-user',
  ]);
  process.stderr.write('\n=== Request Headers ===\n');
  for (const [k, v] of Object.entries(headers)) {
    const display = sensitiveKeys.has(k.toLowerCase()) ? truncateForLog(v) : v;
    process.stderr.write(`  ${k}: ${display}\n`);
  }
  process.stderr.write('=======================\n\n');
}

async function sendRequest(headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const url = new URL(API_URL);

    const reqOptions = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = https.request(reqOptions, (res) => {
      process.stderr.write(
        `\n=== Response: HTTP ${res.statusCode} ${res.statusMessage} ===\n`
      );
      process.stderr.write('Response headers:\n');
      for (const [k, v] of Object.entries(res.headers)) {
        process.stderr.write(`  ${k}: ${v}\n`);
      }
      process.stderr.write('================================\n\n');

      resolve(res);
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function streamSseResponse(res) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let totalChunks = 0;

    res.setEncoding('utf8');

    res.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;

        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Not JSON — print as-is
          process.stdout.write(`${raw}\n`);
          totalChunks++;
          continue;
        }

        // Extract text content from common Qoder SSE shapes
        const text =
          parsed?.choices?.[0]?.delta?.content ??
          parsed?.data?.content ??
          parsed?.content ??
          null;

        if (text !== null && text !== undefined) {
          process.stdout.write(text);
          totalChunks++;
        } else {
          // Print non-text events to stderr for inspection
          process.stderr.write(`[SSE event] ${JSON.stringify(parsed)}\n`);
        }
      }
    });

    res.on('end', () => {
      // Flush any remaining buffer
      if (buffer.trim()) {
        process.stderr.write(`[leftover buffer] ${buffer}\n`);
      }
      process.stdout.write('\n');
      process.stderr.write(`\n[Done] Received ${totalChunks} text chunk(s).\n`);
      resolve();
    });

    res.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 1. Read machineId
  process.stderr.write('[1/5] Reading machineId...\n');
  const machineId = readMachineId();
  process.stderr.write(`      machineId = ${machineId}\n`);

  // 2. Decrypt user cache
  process.stderr.write('[2/5] Decrypting user cache...\n');
  const authData = decryptUserCache(machineId);
  const { uid: userId, key: machineToken, organization_id: organizationId } = authData;
  if (!machineToken) throw new Error('machineToken (key) not found in decrypted auth data');
  process.stderr.write(`      userId = ${userId}\n`);
  process.stderr.write(`      organizationId = ${organizationId}\n`);
  process.stderr.write(`      machineToken length = ${machineToken.length}\n`);

  // 3. Build timestamps + COSY JWT
  process.stderr.write('[3/5] Building COSY JWT...\n');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const { jwt } = buildCosyJwt(machineToken, timestamp);

  // 4. Build HTTP Signature headers
  process.stderr.write('[4/5] Building HTTP Signature headers...\n');
  const { date, httpSig } = buildHttpSigHeaders();

  // 5. Assemble all headers
  const headers = {
    Authorization: jwt,
    'Cosy-User': userId,
    'Cosy-Key': machineToken,
    'Cosy-Date': timestamp,
    Date: date,
    Signature: httpSig,
    Appcode: 'sign',
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'cosy-version': COSY_VERSION,
    'cosy-clienttype': '5',
    'cosy-machineid': machineId,
    'cosy-organization-id': organizationId || '',
    'login-version': 'v2',
    'cosy-data-policy': 'DISAGREE',
    'x-model-key': 'efficient',
    'x-model-source': 'system',
    'accept-encoding': 'identity',
  };

  printHeadersDebug(headers);

  // 6. Send request and stream response
  process.stderr.write('[5/5] Sending request and streaming response...\n\n');
  const testMessage = 'What is 2+2? Reply with just the number.';
  const body = buildRequestBody(testMessage);

  process.stdout.write('=== Response text ===\n');
  const res = await sendRequest(headers, body);
  await streamSseResponse(res);
}

main().catch((err) => {
  process.stderr.write(`\n[ERROR] ${err.message}\n`);
  if (err.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
