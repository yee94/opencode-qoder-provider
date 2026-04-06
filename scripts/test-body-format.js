#!/usr/bin/env node
/**
 * Test different request body approaches:
 * 1. JSON only (no binary header)
 * 2. JSON with different content-types
 * 3. Raw JSON vs custom base64 encoded
 */

import * as fs from 'fs';

const API_URL = 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation';

const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const encodeMap = {};
for (let i = 0; i < CUSTOM_ALPHABET.length; i++) {
  encodeMap[STANDARD_BASE64[i]] = CUSTOM_ALPHABET[i];
}

function encodeCustomBase64(buffer) {
  const standard = buffer.toString('base64');
  let custom = '';
  for (const char of standard) {
    custom += encodeMap[char] || char;
  }
  return custom;
}

const capturedHeaders = JSON.parse(fs.readFileSync('/tmp/forward/headers.json', 'utf8'));

function buildHeaders(contentLength, contentType = 'application/json') {
  return {
    ...capturedHeaders,
    'content-length': contentLength.toString(),
    'cosy-date': Math.floor(Date.now() / 1000).toString(),
    'content-type': contentType
  };
}

function buildJson(message) {
  return {
    request_id: crypto.randomUUID(),
    request_set_id: crypto.randomUUID(),
    chat_record_id: crypto.randomUUID(),
    stream: true,
    chat_task: "FREE_INPUT",
    chat_context: {
      chatPrompt: "",
      extra: {
        context: [],
        modelConfig: { is_reasoning: false, key: "q35model_preview" }
      },
      features: [],
      imageUrls: null,
      text: { type: "text", text: message }
    },
    image_urls: null,
    is_reply: true,
    is_retry: false,
    session_id: crypto.randomUUID(),
    model_config: {
      key: "q35model_preview",
      display_name: "Qwen3.6-Plus-DogFooding",
      model: "",
      format: "openai",
      is_vl: true,
      is_reasoning: false,
      api_key: "",
      url: "",
      source: "system",
      max_input_tokens: 180000
    },
    messages: [
      {
        role: "user",
        content: message,
        contents: [{ type: "text", text: message }],
        response_meta: {
          id: "",
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            completion_tokens_details: { reasoning_tokens: 0 },
            prompt_tokens_details: { cached_tokens: 0 }
          }
        },
        reasoning_content_signature: ""
      }
    ]
  };
}

async function testRequest(name, body, headers) {
  console.log(`\nTest: ${name}`);
  console.log(`Body size: ${body.length} bytes`);
  
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers,
      body
    });
    
    console.log(`Status: ${response.status}`);
    
    if (response.ok) {
      const text = await response.text();
      console.log(`Response (first 500 chars):\n${text.substring(0, 500)}`);
      return true;
    } else {
      const error = await response.text();
      console.log(`Error: ${error}`);
      return false;
    }
  } catch (err) {
    console.log(`Network error: ${err.message}`);
    return false;
  }
}

async function main() {
  const message = "What is 2+2?";
  const json = buildJson(message);
  const jsonStr = JSON.stringify(json);
  
  console.log('=== Qoder API Body Format Tests ===\n');
  
  // Test 1: Raw JSON with application/json
  await testRequest(
    'Raw JSON (application/json)',
    jsonStr,
    buildHeaders(jsonStr.length, 'application/json')
  );
  
  // Test 2: Custom base64 encoded JSON
  const encodedJson = encodeCustomBase64(Buffer.from(jsonStr, 'utf-8'));
  await testRequest(
    'Custom base64 encoded JSON',
    encodedJson,
    buildHeaders(encodedJson.length, 'application/json')
  );
  
  // Test 3: Custom base64 with text/plain
  await testRequest(
    'Custom base64 (text/plain)',
    encodedJson,
    buildHeaders(encodedJson.length, 'text/plain')
  );
  
  console.log('\n=== Tests Complete ===');
}

main().catch(console.error);
