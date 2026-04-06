#!/bin/bash
# Qoder Request Capture & Replay
# 
# This script:
# 1. Starts mitmdump to capture the next request
# 2. Runs qodercli -p "test" to generate a request
# 3. Extracts the encoded body and headers
# 4. Decodes the body
# 5. Asks user for the real message
# 6. Replaces the user message
# 7. Re-encodes with the same alphabet
# 8. Sends the request
#
# Usage: ./scripts/qoder-capture-and-replay.sh

set -e

CAPTURE_DIR="/tmp/qoder-capture-$$"
mkdir -p "$CAPTURE_DIR"

echo "=== Qoder Request Capture & Replay ==="
echo ""

# Step 1: Start mitmdump
echo "📡 Starting mitmdump..."
mitmdump -w "$CAPTURE_DIR/flows" --set flow_detail=0 > "$CAPTURE_DIR/mitm.log" 2>&1 &
MITM_PID=$!

# Wait for mitmproxy to start
sleep 2

echo "✓ mitmdump started (PID: $MITM_PID)"

# Step 2: Configure proxy and send test request
echo ""
echo "🔨 Running qodercli -p 'test'..."
HTTPS_PROXY=http://127.0.0.1:8080 HTTP_PROXY=http://127.0.0.1:8080 \
  qodercli -p "test" > "$CAPTURE_DIR/qoder_output.txt" 2>&1 &
QODER_PID=$!

# Wait a bit then kill mitmproxy
sleep 5

# Step 3: Extract the request from mitmproxy flow file
echo ""
echo "📥 Extracting request..."

# Use mitmdump to read the flow and extract the request
mitmdump -nr "$CAPTURE_DIR/flows" \
  --set console_strip_trailing_newlines=true \
  --script - << 'PYTHON_SCRIPT' > "$CAPTURE_DIR/extracted.txt" 2>&1
import json
import sys

def response(flow):
    if 'qoder.sh' in flow.request.pretty_url:
        # Save request body
        with open('/tmp/qoder_capture_body.bin', 'wb') as f:
            f.write(flow.request.content)
        
        # Save request headers
        headers = dict(flow.request.headers)
        with open('/tmp/qoder_capture_headers.json', 'w') as f:
            json.dump(headers, f, indent=2)
        
        print(f"✓ Captured request to {flow.request.pretty_url}")
        print(f"  Body size: {len(flow.request.content)} bytes")
        print(f"  Headers: {len(headers)} fields")
PYTHON_SCRIPT

# Kill processes
kill $MITM_PID 2>/dev/null || true
kill $QODER_PID 2>/dev/null || true

# Wait for cleanup
sleep 1

# Check if we captured anything
if [ ! -f "/tmp/qoder_capture_body.bin" ]; then
    echo "❌ Failed to capture request"
    echo "Check $CAPTURE_DIR/mitm.log for errors"
    exit 1
fi

echo "✓ Request captured"
echo "  Body: /tmp/qoder_capture_body.bin ($(wc -c < /tmp/qoder_capture_body.bin) bytes)"
echo "  Headers: /tmp/qoder_capture_headers.json"

# Step 4: Ask user for message
echo ""
read -p "💬 Enter your message: " USER_MESSAGE

if [ -z "$USER_MESSAGE" ]; then
    echo "❌ Empty message, exiting"
    exit 1
fi

# Step 5: Use Node.js to decode, modify, re-encode, and send
echo ""
echo "🔄 Processing request..."

node << NODEJS_SCRIPT
const fs = require('fs');

const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Read captured files
const encodedBody = fs.readFileSync('/tmp/qoder_capture_body.bin', 'ascii').trim();
const headers = JSON.parse(fs.readFileSync('/tmp/qoder_capture_headers.json', 'utf-8'));

// Decode
function decode(ciphertext) {
  const transTable = new Map();
  for (let i = 0; i < CUSTOM_ALPHABET.length; i++) {
    transTable.set(CUSTOM_ALPHABET[i], STANDARD_BASE64[i]);
  }
  
  const translated = ciphertext.split('').map(c => transTable.get(c) || c).join('');
  const padding = (4 - translated.length % 4) % 4;
  const padded = translated + '='.repeat(padding);
  
  return Buffer.from(padded, 'base64').toString('utf-8');
}

// Encode  
function encode(plaintext) {
  const encoded = Buffer.from(plaintext, 'utf-8').toString('base64').replace(/=/g, '');
  const transTable = new Map();
  for (let i = 0; i < STANDARD_BASE64.length; i++) {
    transTable.set(STANDARD_BASE64[i], CUSTOM_ALPHABET[i]);
  }
  return encoded.split('').map(c => transTable.get(c) || c).join('');
}

// Decode the request
console.error('🔓 Decoding request...');
let decoded;
try {
  decoded = decode(encodedBody);
  console.error('✓ Decoded successfully (' + decoded.length + ' bytes)');
} catch (e) {
  console.error('❌ Decode failed: ' + e.message);
  process.exit(1);
}

// Parse JSON
const request = JSON.parse(decoded);
console.error('✓ Parsed JSON (' + Object.keys(request).join(', ') + ')');

// Replace user message
const userMessage = process.env.USER_MESSAGE || '${USER_MESSAGE}';
let replaced = false;

if (request.messages) {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    if (request.messages[i].role === 'user') {
      request.messages[i].content = userMessage;
      if (request.messages[i].contents) {
        request.messages[i].contents = [{
          type: 'text',
          text: userMessage,
        }];
      }
      console.error('✓ Replaced user message at index ' + i);
      replaced = true;
      break;
    }
  }
}

if (!replaced) {
  console.error('⚠ No user message found, appending');
  request.messages.push({
    role: 'user',
    content: userMessage,
    contents: [{ type: 'text', text: userMessage }],
  });
}

// Re-encode
console.error('🔒 Re-encoding...');
const newBody = JSON.stringify(request);
const newEncodedBody = encode(newBody);
console.error('✓ Encoded (' + newEncodedBody.length + ' bytes)');

// Update headers
const timestamp = Math.floor(Date.now() / 1000);
headers['cosy-date'] = String(timestamp);
headers['content-length'] = String(newEncodedBody.length);

console.error('📡 Sending request...');

const url = 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';

fetch(url, {
  method: 'POST',
  headers: headers,
  body: newEncodedBody,
})
.then(async response => {
  if (!response.ok) {
    const err = await response.text();
    throw new Error('HTTP ' + response.status + ': ' + err);
  }
  
  console.error('✅ Response received\\n');
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';
  
  async function read() {
    const { done, value } = await reader.read();
    if (done) return;
    
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\\n');
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
              console.error('\\n\\n✨ Finished: ' + choice.finish_reason);
            }
          }
        } catch (e) {
          // Skip non-JSON
        }
      }
    }
    
    await read();
  }
  
  await read();
  return fullResponse;
})
.then(response => {
  console.error('\\n✓ Complete');
})
.catch(err => {
  console.error('\\n❌ Error: ' + err.message);
  process.exit(1);
});
NODEJS_SCRIPT

# Cleanup
echo ""
echo "🧹 Cleaning up..."
rm -rf "$CAPTURE_DIR"

echo "✓ Done"
