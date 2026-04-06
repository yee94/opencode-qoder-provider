#!/usr/bin/env node
/**
 * Qoder API Client - Production Version
 * Successfully bypasses SDK and makes direct LLM API calls
 */

import * as fs from 'fs';

const API_URL = 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation';

// Read captured headers
const capturedHeaders = JSON.parse(fs.readFileSync('/tmp/forward/headers.json', 'utf8'));

function buildJwt(requestId) {
  const parts = capturedHeaders['authorization'].replace('Bearer ', '').split('.');
  const originalPayload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
  const newPayload = { ...originalPayload, requestId };
  const newPayloadBase64 = Buffer.from(JSON.stringify(newPayload)).toString('base64');
  return `COSY.${newPayloadBase64}.${parts[2]}`;
}

function buildRequest(message, model = 'q35model_preview') {
  const requestId = crypto.randomUUID();
  return {
    requestId,
    request: {
      request_id: requestId,
      request_set_id: crypto.randomUUID(),
      chat_record_id: crypto.randomUUID(),
      stream: true,
      chat_task: "FREE_INPUT",
      chat_context: {
        chatPrompt: "",
        extra: {
          context: [],
          modelConfig: { is_reasoning: false, key: model }
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
        key: model,
        display_name: model,
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
      }]
    }
  };
}

async function query(message, model = 'q35model_preview') {
  const requestId = crypto.randomUUID();
  const request = buildRequest(message, model);
  const body = JSON.stringify(request);
  
  const headers = {
    ...capturedHeaders,
    'content-length': body.length.toString(),
    'cosy-date': Math.floor(Date.now() / 1000).toString(),
    'authorization': buildJwt(requestId)
  };
  
  const response = await fetch(API_URL, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(60000) // 60 second timeout
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  
  // Process SSE
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';
  
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      
      const data = line.substring(5).trim();
      if (!data || data === '[DONE]') continue;
      
      try {
        const parsed = JSON.parse(data);
        
        // Check for error responses
        if (parsed.statusCode === 'FORBIDDEN') {
          const inner = JSON.parse(parsed.body);
          throw new Error(`${inner.code}: ${inner.message}`);
        }
        
        // Extract text from response - try multiple formats
        const text = parsed.choices?.[0]?.delta?.content ||
                    parsed.choices?.[0]?.text ||
                    parsed.text ||
                    parsed.delta?.text ||
                    parsed.content ||
                    parsed.output?.text ||
                    '';
        
        if (text) {
          fullText += text;
        }
      } catch (e) {
        if (e.message.includes('FORBIDDEN')) throw e;
      }
    }
  }
  
  return fullText;
}

// CLI interface
const message = process.argv.slice(2).join(' ') || 'Hello, what can you do?';
console.log(`Qoder API Client\nMessage: ${message}\n`);

query(message)
  .then(response => {
    console.log('\n=== Response ===');
    console.log(response);
    console.log(`\n(${response.length} chars)`);
  })
  .catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
