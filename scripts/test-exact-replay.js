#!/usr/bin/env node
/**
 * Replay EXACT captured request (no modifications)
 * If this works, we know the issue is with our modified body
 */

import * as fs from 'fs';

const API_URL = 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation';

// Decode custom base64
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const decodeMap = {};
for (let i = 0; i < CUSTOM_ALPHABET.length; i++) {
  decodeMap[CUSTOM_ALPHABET[i]] = STANDARD_BASE64[i];
}

function decodeCustomBase64(encoded) {
  let standard = '';
  for (const char of encoded) {
    if (decodeMap[char]) standard += decodeMap[char];
    else if (char === '=') standard += '=';
  }
  return Buffer.from(standard, 'base64');
}

const encodeMap = {};
for (let i = 0; i < STANDARD_BASE64.length; i++) {
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

async function main() {
  console.log('=== Exact Request Replay Test ===\n');
  
  // Option 1: Replay EXACT captured encoded body
  const capturedBody = fs.readFileSync('/tmp/forward/body.bin', 'utf8').trim();
  const capturedHeaders = JSON.parse(fs.readFileSync('/tmp/forward/headers.json', 'utf8'));
  
  console.log('Test 1: Replay EXACT captured request');
  console.log(`Body size: ${capturedBody.length} bytes`);
  console.log(`Original timestamp: ${capturedHeaders['cosy-date']} (${new Date(parseInt(capturedHeaders['cosy-date']) * 1000)})`);
  
  try {
    const resp1 = await fetch(API_URL, {
      method: 'POST',
      headers: capturedHeaders,
      body: capturedBody
    });
    
    console.log(`Status: ${resp1.status}`);
    
    const reader1 = resp1.body.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader1.read();
    const text1 = decoder.decode(value);
    console.log(`Response: ${text1.substring(0, 300)}\n`);
  } catch (err) {
    console.log(`Error: ${err.message}\n`);
  }
  
  // Option 2: Decode, modify message, re-encode
  console.log('Test 2: Decode, modify message, re-encode');
  const decoded = decodeCustomBase64(capturedBody);
  const jsonStart = 50043;
  const binaryHeader = decoded.subarray(0, jsonStart);
  const originalJson = decoded.subarray(jsonStart);
  
  console.log(`Binary header: ${binaryHeader.length} bytes`);
  console.log(`Original JSON: ${originalJson.length} bytes`);
  
  // Parse original JSON
  try {
    const parsed = JSON.parse(originalJson.toString('utf-8'));
    console.log('✓ Parsed original JSON');
    console.log(`  request_id: ${parsed.request_id}`);
    console.log(`  messages[0].content: ${parsed.messages?.[0]?.content?.substring(0, 50)}`);
  } catch (e) {
    console.log('✗ Could not parse JSON (expected - may be truncated)');
  }
  
  // Create new request with same structure but different message
  const newMessage = "What is 10+10?";
  const newJson = {
    request_id: crypto.randomUUID(),
    request_set_id: crypto.randomUUID(),
    chat_record_id: crypto.randomUUID(),
    stream: true,
    chat_task: "FREE_INPUT",
    chat_context: {
      chatPrompt: "",
      extra: { context: [], modelConfig: { is_reasoning: false, key: "q35model_preview" } },
      features: [],
      imageUrls: null,
      text: { type: "text", text: newMessage }
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
    messages: [{
      role: "user",
      content: newMessage,
      contents: [{ type: "text", text: newMessage }],
      response_meta: {
        id: "",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens_details: { cached_tokens: 0 } }
      },
      reasoning_content_signature: ""
    }]
  };
  
  // Try WITHOUT binary header (just JSON)
  const newJsonStr = JSON.stringify(newJson);
  console.log(`\nNew JSON only: ${newJsonStr.length} bytes`);
  
  const headers2 = {
    ...capturedHeaders,
    'content-length': newJsonStr.length.toString(),
    'cosy-date': Math.floor(Date.now() / 1000).toString()
  };
  
  try {
    const resp2 = await fetch(API_URL, {
      method: 'POST',
      headers: headers2,
      body: newJsonStr
    });
    
    console.log(`Status: ${resp2.status}`);
    
    const reader2 = resp2.body.getReader();
    const { value } = await reader2.read();
    const text2 = new TextDecoder().decode(value);
    console.log(`Response: ${text2.substring(0, 300)}`);
  } catch (err) {
    console.log(`Error: ${err.message}`);
  }
  
  console.log('\n=== Tests Complete ===');
}

main().catch(console.error);
