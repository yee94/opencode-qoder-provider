#!/usr/bin/env node
/**
 * Qoder Request Replay Script
 * 
 * Strategy: Since the custom base64 alphabet changes per request (cosy-key shuffle),
 * we must use a CAPTURED request's encoded body directly, not re-encode.
 * 
 * Approach:
 * 1. Load a recently captured encoded request body (.bin file)
 * 2. Load its corresponding headers (with matching cosy-key and authorization)
 * 3. Decode the body, replace user message, re-encode with SAME alphabet
 * 4. Send with the SAME headers (updating only timestamp and content-length)
 * 
 * Usage:
 *   node scripts/qoder-replay-request.js "Your new question"
 *   node scripts/qoder-replay-request.js "Explain Go" --model performance
 * 
 * Prerequisites:
 *   - /tmp/qoder_request_latest.bin (encoded request body)
 *   - /tmp/qoder_headers_latest.json (request headers)
 *   - The custom alphabet used to encode the request
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createDecipheriv, randomUUID } from 'crypto';

// ── Configuration ─────────────────────────────────────────────────────────────

// Default file paths
const DEFAULT_BODY_PATH = '/tmp/qoder_request_latest.bin';
const DEFAULT_HEADERS_PATH = '/tmp/qoder_headers_latest.json';

// Fallback to older capture paths
const FALLBACK_BODY_PATH = '/tmp/qoder_request_3.bin';
const FALLBACK_HEADERS_PATH = '/tmp/latest_headers_1.json';

// ── Load Captured Request ─────────────────────────────────────────────────────
function loadCapturedRequest() {
  // Load decoded request from previous capture
  const decodedPath = '/tmp/decoded_request_3.json';
  
  if (!fs.existsSync(decodedPath)) {
    throw new Error(`Decoded request not found at ${decodedPath}. Please decode a captured request first.`);
  }
  
  const decodedText = fs.readFileSync(decodedPath, 'utf-8');
  
  // Find JSON structure
  const firstBrace = decodedText.indexOf('{');
  const lastBrace = decodedText.lastIndexOf('}');
  
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('No JSON structure found in decoded request');
  }
  
  const jsonText = decodedText.substring(firstBrace, lastBrace + 1);
  
  try {
    const parsed = JSON.parse(jsonText);
    console.error(`✓ Loaded captured request (${jsonText.length} chars)`);
    console.error(`  Keys: ${Object.keys(parsed).join(', ')}`);
    return parsed;
  } catch (e) {
    // If full JSON doesn't parse, try to find the messages array
    const msgMatch = decodedText.match(/"messages"\s*:\s*\[/);
    if (msgMatch) {
      console.error(`✓ Found messages array in captured request`);
      return null; // We'll build a minimal request
    }
    throw new Error(`Failed to parse captured request: ${e.message}`);
  }
}

// ── Load Captured Headers ─────────────────────────────────────────────────────
function loadCapturedHeaders() {
  const headersPath = '/tmp/latest_headers_1.json';
  
  if (!fs.existsSync(headersPath)) {
    throw new Error(`Captured headers not found at ${headersPath}. Please capture a request first.`);
  }
  
  const headers = JSON.parse(fs.readFileSync(headersPath, 'utf-8'));
  console.error(`✓ Loaded captured headers`);
  
  return headers;
}

// ── Build New Request ─────────────────────────────────────────────────────────
function buildNewRequest(capturedRequest, userMessage, options = {}) {
  // If we have the full captured request, reuse its structure
  if (capturedRequest && capturedRequest.messages) {
    console.error(`  Reusing captured request structure with ${capturedRequest.messages.length} messages`);
    
    // Find the last user message and replace its content
    const newMessages = [...capturedRequest.messages];
    
    // Replace the last user message
    for (let i = newMessages.length - 1; i >= 0; i--) {
      if (newMessages[i].role === 'user') {
        newMessages[i] = {
          ...newMessages[i],
          content: userMessage,
          contents: [{
            type: 'text',
            text: userMessage,
          }],
        };
        console.error(`  Replaced user message at index ${i}`);
        break;
      }
    }
    
    const newRequest = {
      ...capturedRequest,
      messages: newMessages,
      model: options.model || capturedRequest.model,
      stream: options.stream !== undefined ? options.stream : capturedRequest.stream,
    };
    
    return JSON.stringify(newRequest);
  }
  
  // Fallback: build minimal request
  console.error(`  Building minimal request structure`);
  
  const request = {
    model: options.model || 'efficient',
    messages: [
      {
        role: 'user',
        content: userMessage,
        contents: [{ type: 'text', text: userMessage }],
      },
    ],
    stream: options.stream !== false,
    temperature: 0.7,
    max_tokens: 64000,
    thinking: { type: 'disabled' },
  };
  
  return JSON.stringify(request);
}

// ── Send Request ──────────────────────────────────────────────────────────────
async function sendRequest(userMessage, options = {}) {
  console.error('🔄 Loading captured request and headers...');
  
  let capturedRequest;
  try {
    capturedRequest = loadCapturedRequest();
  } catch (e) {
    console.error(`⚠ ${e.message}`);
    console.error('  Falling back to minimal request structure');
    capturedRequest = null;
  }
  
  const capturedHeaders = loadCapturedHeaders();
  
  console.error(`📝 Building request with message: "${userMessage.substring(0, 50)}..."`);
  const plaintext = buildNewRequest(capturedRequest, userMessage, options);
  console.error(`  Request size: ${plaintext.length} bytes`);
  
  console.error('🔒 Encoding request body...');
  const encodedBody = encodeToCustomBase64(plaintext);
  console.error(`  Encoded size: ${encodedBody.length} bytes`);
  
  console.error('📡 Sending request...');
  
  // Build headers from captured ones, update dynamic fields
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = {
    ...capturedHeaders,
    'cosy-date': String(timestamp),
    'content-length': String(encodedBody.length),
    'x-model-key': options.model || capturedHeaders['x-model-key'] || 'efficient',
  };
  
  // Remove content-encoding if present
  delete headers['content-encoding'];
  
  if (process.env.QODER_DEBUG === '1') {
    console.error('\n📋 Request Headers:');
    console.error(JSON.stringify(headers, null, 2));
    console.error('\n📄 Request Body (first 500 chars):');
    console.error(plaintext.substring(0, 500));
    console.error('\n📦 Encoded Body (first 100 chars):');
    console.error(encodedBody.substring(0, 100));
    console.error('\n' + '─'.repeat(80));
  }
  
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
          // Skip non-JSON lines
        }
      }
    }
  }
  
  return fullResponse;
}

// ── CLI Interface ─────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  
  let message = '';
  const options = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--model' && args[i + 1]) {
      options.model = args[++i];
    } else if (arg === '--stream' && args[i + 1]) {
      options.stream = args[i + 1] === 'false' ? false : true;
    } else if (!message) {
      message = arg;
    }
  }
  
  if (!message) {
    console.error(`
Usage: node scripts/qoder-replay-request.js "Your question" [options]

Options:
  --model <name>     Model to use (default: from captured request)
  --stream <bool>    Enable/disable streaming (default: true)

Examples:
  node scripts/qoder-replay-request.js "Explain Go generics"
  node scripts/qoder-replay-request.js "Review this code" --model performance
`);
    process.exit(1);
  }
  
  return { message, options };
}

// ── Entry Point ───────────────────────────────────────────────────────────────
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
