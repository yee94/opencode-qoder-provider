#!/usr/bin/env node
/**
 * Debug SSE response format
 */

import * as fs from 'fs';

const API_URL = 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation';

async function main() {
  const message = "What is 2+2?";
  console.log(`Message: ${message}\n`);
  
  const capturedHeaders = JSON.parse(fs.readFileSync('/tmp/forward/headers.json', 'utf8'));
  
  const request = {
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
  
  const body = JSON.stringify(request);
  const headers = {
    ...capturedHeaders,
    'content-length': body.length.toString(),
    'cosy-date': Math.floor(Date.now() / 1000).toString()
  };
  
  const response = await fetch(API_URL, {
    method: 'POST',
    headers,
    body
  });
  
  console.log(`Status: ${response.status}`);
  console.log(`Content-Type: ${response.headers.get('content-type')}\n`);
  
  // Read ALL raw data
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rawResponse = '';
  let eventCount = 0;
  
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value, { stream: true });
    rawResponse += chunk;
    eventCount += (chunk.match(/^data:/gm) || []).length;
    
    console.log(`[Chunk] ${chunk.length} bytes, ${chunk.split('\n').length} lines`);
    console.log(chunk.substring(0, 500));
    console.log('---');
  }
  
  // Save full raw response
  fs.writeFileSync('/tmp/sse-raw-response.txt', rawResponse);
  
  console.log(`\n=== Summary ===`);
  console.log(`Total raw response: ${rawResponse.length} bytes`);
  console.log(`SSE events: ${eventCount}`);
  console.log(`Saved to: /tmp/sse-raw-response.txt`);
  
  // Try to parse first event
  const firstEvent = rawResponse.split('\n\n')[0];
  console.log(`\nFirst SSE event:\n${firstEvent}`);
  
  if (firstEvent.startsWith('data:')) {
    const data = firstEvent.substring(5).trim();
    try {
      const parsed = JSON.parse(data);
      console.log(`\nParsed JSON keys:`, Object.keys(parsed));
      console.log(`Full JSON structure (first 1000 chars):`);
      console.log(JSON.stringify(parsed, null, 2).substring(0, 1000));
    } catch (e) {
      console.log(`\nData is not JSON: ${data.substring(0, 200)}`);
    }
  }
}

main().catch(console.error);
