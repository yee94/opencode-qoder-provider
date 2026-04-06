#!/usr/bin/env node
/**
 * Qoder Quick Replay Script
 *
 * Simple approach: Use the most recently captured request data.
 * Since alphabet changes per request, we must use data captured within minutes.
 *
 * Usage: node scripts/qoder-quick-replay.js "Your message"
 */

import * as fs from 'fs';

const KNOWN_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeWithAlphabet(plaintext, alphabet) {
  const encoded = Buffer.from(plaintext, 'utf-8').toString('base64').replace(/=/g, '');
  const transTable = new Map();
  for (let i = 0; i < STANDARD_BASE64.length; i++) {
    transTable.set(STANDARD_BASE64[i], alphabet[i]);
  }
  return encoded.split('').map(c => transTable.get(c) || c).join('');
}

function decodeWithAlphabet(ciphertext, alphabet) {
  const transTable = new Map();
  for (let i = 0; i < alphabet.length; i++) {
    transTable.set(alphabet[i], STANDARD_BASE64[i]);
  }
  const translated = ciphertext.split('').map(c => transTable.get(c) || c).join('');
  const padding = (4 - translated.length % 4) % 4;
  const padded = translated + '='.repeat(padding);
  return Buffer.from(padded, 'base64').toString('utf-8');
}

// Find latest capture
function findLatestCapture() {
  const tmpFiles = fs.readdirSync('/tmp');

  // Look for request captures
  const requestFiles = tmpFiles.filter(f => f.startsWith('qoder_replay_body.bin') || f.startsWith('qoder_request_'));
  const headerFiles = tmpFiles.filter(f => f.startsWith('qoder_replay_headers.json') || f.startsWith('qoder_headers_'));

  if (requestFiles.length === 0) {
    return null;
  }

  // Sort by modification time
  const sorted = requestFiles
    .map(f => ({
      name: f,
      mtime: fs.statSync(`/tmp/${f}`).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  const latestRequest = sorted[0].name;
  const age = (Date.now() - sorted[0].mtime) / 1000 / 60; // minutes

  console.error(`Latest capture: ${latestRequest} (${age.toFixed(1)} minutes ago)`);

  // Find corresponding headers
  let headersFile = null;
  if (latestRequest.includes('replay')) {
    headersFile = 'qoder_replay_headers.json';
  } else {
    const num = latestRequest.match(/qoder_request_(\d+)/)?.[1];
    if (num) {
      headersFile = `qoder_headers_${num}.json`;
    }
  }

  if (!headersFile || !fs.existsSync(`/tmp/${headersFile}`)) {
    console.error(`⚠ Headers file not found`);
    return null;
  }

  return {
    requestPath: `/tmp/${latestRequest}`,
    headersPath: `/tmp/${headersFile}`,
    ageMinutes: age,
  };
}

async function replay(userMessage) {
  console.error('=== Qoder Quick Replay ===\n');

  const capture = findLatestCapture();
  if (!capture) {
    console.error('❌ No captured request found. Please run a capture first.');
    process.exit(1);
  }

  if (capture.ageMinutes > 10) {
    console.error(`⚠ Capture is ${capture.ageMinutes.toFixed(1)} minutes old - tokens may have expired`);
    console.error('  Consider capturing a fresh request');
  }

  // Load captured data
  console.error('\n📥 Loading captured data...');
  const encodedBody = fs.readFileSync(capture.requestPath, 'ascii').trim();
  const headers = JSON.parse(fs.readFileSync(capture.headersPath, 'utf-8'));

  console.error(`  Encoded body: ${encodedBody.length} bytes`);
  console.error(`  Headers: ${Object.keys(headers).length} fields`);

  // Try to decode with known alphabet
  console.error('\n🔓 Attempting to decode...');
  let decoded;
  try {
    decoded = decodeWithAlphabet(encodedBody, KNOWN_ALPHABET);
    console.error(`✓ Decoded with known alphabet (${decoded.length} bytes)`);
  } catch (e) {
    console.error(`✗ Decode failed: ${e.message}`);
    console.error('  Alphabet may have changed. Unable to modify request.');
    console.error('\n  Options:');
    console.error('  1. Capture a fresh request (within 1-2 minutes)');
    console.error('  2. Use the captured request as-is (without modification)');
    process.exit(1);
  }

  // Find and parse JSON
  const jsonStart = decoded.indexOf('{"request_id"');
  if (jsonStart < 0) {
    console.error('✗ Could not find request JSON');
    process.exit(1);
  }

  console.error('✓ Found request JSON');

  // Extract JSON (find matching closing brace)
  let depth = 0;
  let jsonEnd = null;
  for (let i = jsonStart; i < decoded.length; i++) {
    if (decoded[i] === '{') depth++;
    else if (decoded[i] === '}') {
      depth--;
      if (depth === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }

  if (!jsonEnd) {
    console.error('✗ Could not find JSON end');
    process.exit(1);
  }

  const jsonText = decoded.substring(jsonStart, jsonEnd);
  const request = JSON.parse(jsonText);

  console.error(`  Messages: ${request.messages?.length || 0}`);
  console.error(`  Model: ${request.model_config?.key || 'unknown'}`);

  // Modify request
  console.error('\n✏️  Modifying request...');

  // Replace user message
  let replaced = false;
  if (request.messages) {
    for (let i = request.messages.length - 1; i >= 0; i--) {
      if (request.messages[i].role === 'user') {
        request.messages[i].content = userMessage;
        if (request.messages[i].contents) {
          request.messages[i].contents = [{ type: 'text', text: userMessage }];
        }
        console.error(`  ✓ Replaced user message at index ${i}`);
        replaced = true;
        break;
      }
    }
  }

  if (!replaced) {
    console.error('  ⚠ No user message found, appending');
    request.messages.push({
      role: 'user',
      content: userMessage,
      contents: [{ type: 'text', text: userMessage }],
    });
  }

  // Update IDs
  request.request_id = crypto.randomUUID();
  request.request_set_id = crypto.randomUUID();
  request.chat_record_id = request.request_id;

  // Re-encode
  console.error('\n🔒 Re-encoding...');
  const newJson = JSON.stringify(request);
  const newEncoded = encodeWithAlphabet(newJson, KNOWN_ALPHABET);
  console.error(`  ✓ Encoded (${newEncoded.length} bytes)`);

  // Update headers
  console.error('\n📡 Updating headers...');
  const timestamp = Math.floor(Date.now() / 1000);
  headers['cosy-date'] = String(timestamp);
  headers['content-length'] = String(newEncoded.length);
  delete headers['content-encoding'];

  // Send request
  console.error('\n🚀 Sending request...\n');
  console.error('─'.repeat(80));

  const url = 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: newEncoded,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  console.error('✅ Response received\n');
  console.error('─'.repeat(80));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));

          if (data.choices?.[0]) {
            const choice = data.choices[0];

            if (choice.delta?.content) {
              process.stdout.write(choice.delta.content);
              fullResponse += choice.delta.content;
            }

            if (choice.finish_reason && choice.finish_reason !== 'null') {
              console.error('\n\n' + '─'.repeat(80));
              console.error(`\n✨ Finished: ${choice.finish_reason}`);

              if (data.usage) {
                console.error(`📊 Usage: ${JSON.stringify(data.usage)}`);
              }
            }
          }
        } catch (e) {
          // Skip non-JSON
        }
      }
    }
  }

  return fullResponse;
}

// CLI
const userMessage = process.argv[2];
if (!userMessage) {
  console.error('Usage: node scripts/qoder-quick-replay.js "Your message"');
  process.exit(1);
}

replay(userMessage).catch(err => {
  console.error(`\n❌ Error: ${err.message}`);
  if (process.env.QODER_DEBUG === '1') {
    console.error(err.stack);
  }
  process.exit(1);
});
