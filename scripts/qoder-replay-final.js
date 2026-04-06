#!/usr/bin/env node
/**
 * Qoder Replay Request - Final Version
 *
 * Uses a previously decoded request structure, modifies the user message,
 * re-encodes with the same alphabet, and sends with matching headers.
 *
 * Usage:
 *   node scripts/qoder-replay-final.js "Your question"
 */

import * as fs from 'fs';

// ── Configuration ─────────────────────────────────────────────────────────────

// The custom alphabet from the successful decode (request #3)
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// ── Encoding Functions ────────────────────────────────────────────────────────

function encodeToCustomBase64(plaintext) {
  const encoded = Buffer.from(plaintext, 'utf-8').toString('base64').replace(/=/g, '');
  const transTable = new Map();
  for (let i = 0; i < STANDARD_BASE64.length; i++) {
    transTable.set(STANDARD_BASE64[i], CUSTOM_ALPHABET[i]);
  }
  return encoded.split('').map(c => transTable.get(c) || c).join('');
}

// ── Load Request Data ─────────────────────────────────────────────────────────

function loadRequestData() {
  // Try to load the decoded request structure
  const requestPath = '/tmp/valid_request.json';

  if (!fs.existsSync(requestPath)) {
    throw new Error(`Request structure not found at ${requestPath}`);
  }

  const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
  console.error(`✓ Loaded request structure`);
  console.error(`  Keys: ${Object.keys(request).join(', ')}`);
  console.error(`  Messages: ${request.messages?.length || 0}`);
  console.error(`  Stream: ${request.stream}`);

  // Load headers
  const headersPath = '/tmp/qoder_headers_3.json';
  if (!fs.existsSync(headersPath)) {
    throw new Error(`Headers not found at ${headersPath}`);
  }

  const headers = JSON.parse(fs.readFileSync(headersPath, 'utf-8'));
  console.error(`✓ Loaded headers`);

  return { request, headers };
}

// ── Build Modified Request ────────────────────────────────────────────────────

function buildModifiedRequest(originalRequest, newUserMessage, options = {}) {
  const newRequest = { ...originalRequest };

  // Update request_id and timestamp to avoid duplicate detection
  newRequest.request_id = crypto.randomUUID();
  newRequest.request_set_id = crypto.randomUUID();
  newRequest.chat_record_id = newRequest.request_id;

  // Update the user message in the messages array
  if (newRequest.messages) {
    const messages = [...newRequest.messages];

    // Find and replace the last user message
    let replaced = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        messages[i] = {
          ...messages[i],
          content: newUserMessage,
          contents: [{
            type: 'text',
            text: newUserMessage,
          }],
        };
        console.error(`✓ Replaced user message at index ${i}`);
        replaced = true;
        break;
      }
    }

    if (!replaced) {
      console.error(`⚠ No user message found, appending`);
      messages.push({
        role: 'user',
        content: newUserMessage,
        contents: [{ type: 'text', text: newUserMessage }],
      });
    }

    newRequest.messages = messages;
  }

  // Update chat_context if present
  if (newRequest.chat_context) {
    newRequest.chat_context.originalContent = {
      type: 'text',
      text: newUserMessage,
    };
    if (newRequest.chat_context.text) {
      newRequest.chat_context.text = {
        type: 'text',
        text: newUserMessage,
      };
    }
  }

  // Update model if specified
  if (options.model) {
    if (newRequest.model_config) {
      newRequest.model_config.key = options.model;
    }
  }

  return newRequest;
}

// ── Send Request ──────────────────────────────────────────────────────────────

async function sendRequest(userMessage, options = {}) {
  console.error('📥 Loading captured request data...');
  const { request: originalRequest, headers: originalHeaders } = loadRequestData();

  console.error('\n🔧 Building modified request...');
  const modifiedRequest = buildModifiedRequest(originalRequest, userMessage, options);

  const plaintext = JSON.stringify(modifiedRequest);
  console.error(`✓ Request built (${plaintext.length} bytes)`);

  console.error('\n🔒 Encoding request body...');
  const encodedBody = encodeToCustomBase64(plaintext);
  console.error(`✓ Encoded (${encodedBody.length} bytes)`);

  console.error('\n📡 Preparing headers...');
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = {
    ...originalHeaders,
    'cosy-date': String(timestamp),
    'content-length': String(encodedBody.length),
  };

  // Remove content-encoding if present
  delete headers['content-encoding'];

  if (options.model) {
    headers['x-model-key'] = options.model;
  }

  if (process.env.QODER_DEBUG === '1') {
    console.error('\n📋 Headers:');
    console.error(JSON.stringify(headers, null, 2));
    console.error('\n📄 Body (first 300 chars):');
    console.error(plaintext.substring(0, 300));
  }

  console.error('\n🚀 Sending request...\n');

  const url = 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: encodedBody,
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

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let message = '';
  const options = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model' && args[i + 1]) {
      options.model = args[++i];
    } else if (!message) {
      message = arg;
    }
  }

  if (!message) {
    console.error(`
Usage: node scripts/qoder-replay-final.js "Your question" [options]

Options:
  --model <name>     Model to use (default: from captured request)

Examples:
  node scripts/qoder-replay-final.js "Explain Go generics"
  node scripts/qoder-replay-final.js "Review this code" --model performance
`);
    process.exit(1);
  }

  return { message, options };
}

const { message, options } = parseArgs();

try {
  await sendRequest(message, options);
  process.exit(0);
} catch (error) {
  console.error(`\n❌ Error: ${error.message}`);
  if (process.env.QODER_DEBUG === '1' && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
}
