#!/usr/bin/env node
/**
 * Build minimal valid request from captured structure
 * 
 * Based on extracted JSON structure:
 * - JSON starts at offset 50043 of decoded body
 * - Structure: {request_id, request_set_id, chat_record_id, stream, chat_task,
 *               chat_context, model_config, messages: [system, user]}
 * - Preceded by 50043 bytes of binary/tool definitions
 */

import { readFileSync, writeFileSync } from 'fs';

const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const charMap = {};
for (let i = 0; i < CUSTOM_ALPHABET.length; i++) {
  charMap[CUSTOM_ALPHABET[i]] = STANDARD_BASE64[i];
}

function decodeCustomBase64(encoded) {
  let standard = '';
  for (const char of encoded) {
    if (charMap[char]) {
      standard += charMap[char];
    } else if (char === '=') {
      standard += '=';
    }
  }
  return Buffer.from(standard, 'base64');
}

// Read and decode the captured request
const encodedBody = readFileSync('/tmp/forward/body.bin', 'utf8').trim();
const decodedText = decodeCustomBase64(encodedBody).toString('utf8');

// Extract the JSON portion
const jsonStart = 50043;
const jsonText = decodedText.substring(jsonStart);

console.log('Extracting request JSON structure...\n');

// Try to parse what we have - the JSON appears to extend beyond the captured data
// Let's manually construct the beginning to understand the structure
const first500 = jsonText.substring(0, 500);
console.log('First 500 chars of JSON:');
console.log(first500);
console.log('\n' + '='.repeat(80) + '\n');

// Manually parse the fields we can see
function extractField(text, field) {
  const pattern = `"${field}":"([^"]*)" `;
  const match = text.match(new RegExp(pattern));
  return match ? match[1] : null;
}

function extractFieldNoQuote(text, field) {
  const pattern = `"${field}":([^,}\\]]*)`;
  const match = text.match(new RegExp(pattern));
  return match ? match[1].trim() : null;
}

const requestId = extractField(jsonText, 'request_id');
const requestSetId = extractField(jsonText, 'request_set_id');
const chatRecordId = extractField(jsonText, 'chat_record_id');
const stream = extractFieldNoQuote(jsonText, 'stream');
const chatTask = extractField(jsonText, 'chat_task');

console.log('Extracted fields:');
console.log('  request_id:', requestId);
console.log('  request_set_id:', requestSetId);
console.log('  chat_record_id:', chatRecordId);
console.log('  stream:', stream);
console.log('  chat_task:', chatTask);

// Extract model_config
const modelConfigMatch = jsonText.match(/"model_config":(\{[^}]+\})/);
if (modelConfigMatch) {
  console.log('\nmodel_config (partial):');
  try {
    const mc = JSON.parse(modelConfigMatch[1]);
    console.log(JSON.stringify(mc, null, 2));
  } catch (e) {
    console.log(modelConfigMatch[1]);
  }
}

// Extract chat_context
const chatContextMatch = jsonText.match(/"chat_context":(\{[^}]+\})/);
if (chatContextMatch) {
  console.log('\nchat_context (partial):');
  console.log(chatContextMatch[1]);
}

// Now let's find where the first message (system) ends
const firstSystemRole = jsonText.indexOf('"role":"system"');
const firstUserRole = jsonText.indexOf('"role":"user"');

console.log('\nMessage positions:');
console.log('  system message starts at:', firstSystemRole);
console.log('  user message starts at:', firstUserRole);

// The system message content likely contains the AGENTS.md file
// Let's extract a small sample
if (firstSystemRole > 0) {
  const systemContentMatch = jsonText.substring(firstSystemRole).match(/"content":"((?:[^"\\]|\\.)*)"/);
  if (systemContentMatch) {
    const content = systemContentMatch[1].substring(0, 200);
    console.log('\nSystem message content (first 200 chars):');
    console.log(content);
  }
}

// Build a minimal request structure for testing
console.log('\n' + '='.repeat(80));
console.log('\nBuilding minimal test request...\n');

const testRequest = {
  request_id: crypto.randomUUID(),
  request_set_id: crypto.randomUUID(),
  chat_record_id: crypto.randomUUID(),
  stream: true,
  chat_task: "FREE_INPUT",
  chat_context: {
    chatPrompt: "",
    extra: {
      context: [],
      modelConfig: {
        is_reasoning: false,
        key: "q35model_preview"
      }
    }
  },
  model_config: {
    key: "q35model_preview",
    display_name: "Qwen3.6-Plus-DogFooding",
    model: "",
    format: "text"
  },
  messages: [
    {
      role: "user",
      content: "What is the capital of France?"
    }
  ]
};

// Save the test request
writeFileSync('/tmp/test-request.json', JSON.stringify(testRequest, null, 2));
console.log('Test request saved to /tmp/test-request.json');
console.log('\nRequest structure:');
console.log(JSON.stringify(testRequest, null, 2).substring(0, 500));

// Now we need to understand: should we send JUST the JSON, or JSON + binary header?
// Let's check the headers to see what content-type and content-length indicate
const headers = JSON.parse(readFileSync('/tmp/forward/headers.json', 'utf8'));
console.log('\n' + '='.repeat(80));
console.log('\nRequest headers analysis:');
console.log('  content-type:', headers['content-type']);
console.log('  content-length:', headers['content-length']);
console.log('  decoded body size:', decodedText.length);
console.log('  JSON portion size:', jsonText.length);

console.log('\n' + '='.repeat(80));
console.log('\nNext step: Encode test request and attempt to send with captured headers');

import * as crypto from 'crypto';
