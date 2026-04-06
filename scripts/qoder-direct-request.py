#!/usr/bin/env python3
"""
Qoder Direct Request - Working Script

This script sends requests to Qoder API by:
1. Using captured request structure as template
2. Replacing user message
3. Using captured headers and encoded body
4. Sending immediately (before tokens expire)

Key insight: We don't need to crack the encryption!
We just reuse the captured request structure.

Usage:
    python3 scripts/qoder-direct-request.py "Your message"
    python3 scripts/qoder-direct-request.py "Your message" --model efficient
"""

import json
import sys
import os
import time
import base64
import urllib.request
import urllib.error
import subprocess
from collections import Counter

# ── Configuration ────────────────────────────────────────────────────────────

# Known custom alphabet (from successful decode)
KNOWN_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

# API endpoint
API_URL = 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'

# ── Helper Functions ──────────────────────────────────────────────────────────

def decode_custom_base64(ciphertext, alphabet=KNOWN_ALPHABET):
    """Decode custom base64 encoded text"""
    trans = str.maketrans(alphabet, STANDARD_BASE64)
    translated = ciphertext.translate(trans)
    padding = (4 - len(translated) % 4) % 4
    translated += '=' * padding
    return base64.b64decode(translated).decode('utf-8')

def encode_custom_base64(plaintext, alphabet=KNOWN_ALPHABET):
    """Encode text to custom base64"""
    encoded = base64.b64encode(plaintext.encode()).decode().rstrip('=')
    trans = str.maketrans(STANDARD_BASE64, alphabet)
    return encoded.translate(trans)

def capture_fresh_request():
    """
    Capture a fresh request using mitmproxy.
    Returns (encoded_body, headers)
    """
    print("📡 Starting mitmdump...")

    capture_dir = "/tmp/qoder-direct-capture"
    os.makedirs(capture_dir, exist_ok=True)

    # Start mitmdump
    mitm_proc = subprocess.Popen([
        'mitmdump',
        '-w', os.path.join(capture_dir, 'flows'),
        '--set', 'flow_level=0'
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    time.sleep(2)

    # Set proxy
    env = os.environ.copy()
    env['HTTPS_PROXY'] = 'http://127.0.0.1:8080'
    env['HTTP_PROXY'] = 'http://127.0.0.1:8080'

    print("🔨 Running qodercli -p 'test'...")
    qoder_proc = subprocess.Popen(
        ['qodercli', '-p', 'test'],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )

    # Wait for request
    time.sleep(8)

    # Extract
    print("\n📥 Extracting request...")

    extract_script = '''
import json
import sys

def request(flow):
    if 'qoder.sh' in flow.request.pretty_url and 'agent_chat_generation' in flow.request.pretty_url:
        with open('/tmp/qoder_direct_body.bin', 'wb') as f:
            f.write(flow.request.content)

        with open('/tmp/qoder_direct_headers.json', 'w') as f:
            json.dump(dict(flow.request.headers), f, indent=2)

        print(f"✓ Captured ({len(flow.request.content)} bytes)")
        sys.exit(0)
'''

    with open(os.path.join(capture_dir, 'extract.py'), 'w') as f:
        f.write(extract_script)

    result = subprocess.run([
        'mitmdump',
        '-nr', os.path.join(capture_dir, 'flows'),
        '--script', os.path.join(capture_dir, 'extract.py')
    ], capture_output=True, text=True)

    # Cleanup
    mitm_proc.terminate()
    try:
        mitm_proc.wait(timeout=5)
    except:
        mitm_proc.kill()

    qoder_proc.terminate()

    if not os.path.exists('/tmp/qoder_direct_body.bin'):
        print("❌ Failed to capture request")
        return None, None

    print("✓ Request captured")

    # Load
    with open('/tmp/qoder_direct_body.bin', 'r') as f:
        body = f.read().strip()
    with open('/tmp/qoder_direct_headers.json', 'r') as f:
        headers = json.load(f)

    return body, headers

def derive_alphabet(new_encoded, reference_encoded):
    """
    Derive new alphabet from a fresh capture by comparing with reference.

    Both should have similar structure, so character frequencies should match.
    """
    print("\n🔬 Deriving alphabet from fresh capture...")

    # Count frequencies
    new_freq = Counter(new_encoded)
    ref_freq = Counter(reference_encoded)

    # Sort by frequency
    new_by_freq = [c for c, _ in new_freq.most_common(64)]
    ref_by_freq = [c for c, _ in ref_freq.most_common(64)]

    # Map by frequency rank
    # new_char -> ref_char
    mapping = dict(zip(new_by_freq, ref_by_freq))

    # Now build the new alphabet
    # ref_char is in KNOWN_ALPHABET space
    # We need to map: STANDARD_BASE64 -> new_char

    new_alphabet = [''] * 64
    for new_char, ref_char in mapping.items():
        ref_idx = KNOWN_ALPHABET.index(ref_char)
        new_alphabet[ref_idx] = new_char

    return ''.join(new_alphabet)

def load_existing_capture():
    """Load the most recent capture from /tmp"""
    print("📥 Looking for existing capture...")

    # Check for recent captures
    candidates = [
        ('/tmp/qoder_request_3.bin', '/tmp/qoder_headers_3.json'),
        ('/tmp/qoder_replay_body.bin', '/tmp/qoder_replay_headers.json'),
        ('/tmp/qoder_direct_body.bin', '/tmp/qoder_direct_headers.json'),
    ]

    for body_path, headers_path in candidates:
        if os.path.exists(body_path) and os.path.exists(headers_path):
            mtime = os.path.getmtime(body_path)
            age = (time.time() - mtime) / 60  # minutes

            if age < 15:  # Only use captures < 15 minutes old
                print(f"✓ Found capture ({age:.1f} minutes old)")

                with open(body_path, 'r') as f:
                    body = f.read().strip()
                with open(headers_path, 'r') as f:
                    headers = json.load(f)

                return body, headers
            else:
                print(f"  {body_path} too old ({age:.1f} min)")

    return None, None

def send_request(user_message, options=None):
    """
    Send a request to Qoder API.

    Strategy:
    1. Use existing capture if available and fresh
    2. Otherwise capture a new one
    3. Decode, modify, re-encode, send
    """
    if options is None:
        options = {}

    print("=== Qoder Direct Request ===\n")

    # Step 1: Get captured data
    encoded_body, headers = load_existing_capture()

    if not encoded_body:
        print("\n⚠ No fresh capture found")
        print("  Capturing fresh request...")
        encoded_body, headers = capture_fresh_request()

        if not encoded_body:
            print("❌ Failed to capture request")
            sys.exit(1)

    # Step 2: Try to decode with known alphabet
    print("\n🔓 Decoding request...")
    decoded = None

    try:
        decoded = decode_custom_base64(encoded_body, KNOWN_ALPHABET)
        print("✓ Decoded with known alphabet")
    except:
        print("✗ Known alphabet failed")

        # Try to derive new alphabet
        # Load reference (request #3 which we know the alphabet for)
        ref_path = '/tmp/qoder_request_3.bin'
        if os.path.exists(ref_path):
            with open(ref_path, 'r') as f:
                ref_body = f.read().strip()

            print("  Attempting to derive new alphabet...")
            new_alphabet = derive_alphabet(encoded_body, ref_body)

            try:
                decoded = decode_custom_base64(encoded_body, new_alphabet)
                print(f"✓ Decoded with derived alphabet!")

                # Save new alphabet for future use
                with open('/tmp/qoder_current_alphabet.txt', 'w') as f:
                    f.write(new_alphabet)
                print(f"  Alphabet saved for reuse")
            except Exception as e:
                print(f"✗ Derived alphabet also failed: {e}")

    if not decoded:
        print("\n❌ Cannot decode request body")
        print("  Please capture a fresh request and try again")
        sys.exit(1)

    # Step 3: Extract and modify JSON
    print("\n📝 Modifying request...")

    # Find JSON
    json_start = decoded.find('{"request_id"')
    if json_start < 0:
        # Try to find any JSON
        for pattern in ['{"stream"', '{"messages"', '{"model"']:
            json_start = decoded.find(pattern)
            if json_start >= 0:
                # Find the { before it
                json_start = decoded.rfind('{', 0, json_start + 100)
                break

    if json_start < 0:
        print("✗ Could not find JSON in decoded request")
        print(f"First 200 chars: {decoded[:200]}")
        sys.exit(1)

    # Extract JSON
    depth = 0
    json_end = None
    for i in range(json_start, len(decoded)):
        if decoded[i] == '{':
            depth += 1
        elif decoded[i] == '}':
            depth -= 1
            if depth == 0:
                json_end = i + 1
                break

    if not json_end:
        print("✗ Could not find JSON end")
        sys.exit(1)

    json_text = decoded[json_start:json_end]
    request = json.loads(json_text)

    print(f"✓ Parsed request")
    print(f"  Messages: {len(request.get('messages', []))}")

    # Modify user message
    replaced = False
    if 'messages' in request:
        for i in range(len(request['messages']) - 1, -1, -1):
            if request['messages'][i].get('role') == 'user':
                request['messages'][i]['content'] = user_message
                if 'contents' in request['messages'][i]:
                    request['messages'][i]['contents'] = [{
                        'type': 'text',
                        'text': user_message,
                    }]
                print(f"✓ Replaced user message at index {i}")
                replaced = True
                break

    if not replaced:
        print("⚠ No user message found, appending")
        request['messages'].append({
            'role': 'user',
            'content': user_message,
            'contents': [{'type': 'text', 'text': user_message}],
        })

    # Update IDs
    import uuid
    request['request_id'] = str(uuid.uuid4())
    request['request_set_id'] = str(uuid.uuid4())
    request['chat_record_id'] = request['request_id']

    # Update model if specified
    if options.get('model'):
        if 'model_config' in request:
            request['model_config']['key'] = options['model']
        request['model'] = options['model']

    # Step 4: Re-encode
    print("\n🔒 Re-encoding...")

    # Determine which alphabet to use
    alphabet = KNOWN_ALPHABET
    if os.path.exists('/tmp/qoder_current_alphabet.txt'):
        with open('/tmp/qoder_current_alphabet.txt', 'r') as f:
            alphabet = f.read().strip()
        print(f"  Using derived alphabet")
    else:
        print(f"  Using known alphabet")

    new_json = json.dumps(request, ensure_ascii=False)
    new_encoded = encode_custom_base64(new_json, alphabet)
    print(f"✓ Encoded ({len(new_encoded)} bytes)")

    # Step 5: Update headers
    print("\n📡 Preparing headers...")
    timestamp = int(time.time())
    headers['cosy-date'] = str(timestamp)
    headers['content-length'] = str(len(new_encoded))
    headers.pop('content-encoding', None)

    if options.get('model'):
        headers['x-model-key'] = options['model']

    # Step 6: Send request
    print("\n🚀 Sending request...\n")
    print("─" * 80)

    try:
        req = urllib.request.Request(
            API_URL,
            data=new_encoded.encode('ascii'),
            headers=headers,
            method='POST'
        )

        with urllib.request.urlopen(req, timeout=120) as response:
            print("\n✅ Response received\n")
            print("─" * 80)

            full_response = ''
            buffer = ''

            while True:
                chunk = response.read(4096)
                if not chunk:
                    break

                buffer += chunk.decode('utf-8')
                lines = buffer.split('\n')
                buffer = lines.pop() if lines else ''

                for line in lines:
                    if line.startswith('data: '):
                        try:
                            data = json.loads(line[6:])
                            if data.get('choices', [{}])[0]:
                                choice = data['choices'][0]
                                if choice.get('delta', {}).get('content'):
                                    content = choice['delta']['content']
                                    print(content, end='', flush=True)
                                    full_response += content

                                if choice.get('finish_reason') and choice['finish_reason'] != 'null':
                                    print(f"\n\n{'─' * 80}")
                                    print(f"\n✨ Finished: {choice['finish_reason']}")
                                    if data.get('usage'):
                                        print(f"📊 Usage: {json.dumps(data['usage'])}")
                        except json.JSONDecodeError:
                            continue

            return full_response

    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8', errors='replace')
        print(f"\n❌ HTTP Error {e.code}")
        print(f"Response: {error_body[:500]}")

        # Save for debugging
        with open('/tmp/qoder_error_response.txt', 'w') as f:
            f.write(f"Status: {e.code}\nHeaders: {dict(e.headers)}\nBody: {error_body}")
        print(f"\nError details saved to /tmp/qoder_error_response.txt")

    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()

    return None

# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    user_message = sys.argv[1] if len(sys.argv) > 1 else None
    model = None

    if '--model' in sys.argv:
        idx = sys.argv.index('--model')
        if idx + 1 < len(sys.argv):
            model = sys.argv[idx + 1]

    if not user_message:
        print("Usage: python3 scripts/qoder-direct-request.py \"Your message\" [--model <name>]")
        print("\nModels: auto, ultimate, performance, efficient, lite,")
        print("        q35model_preview, qmodel, q35model, gmodel, kmodel, mmodel")
        sys.exit(1)

    options = {'model': model} if model else {}
    result = send_request(user_message, options)

    if result:
        print(f"\n\n✓ Complete response: {len(result)} characters")
    else:
        print("\n❌ Request failed")
        sys.exit(1)
