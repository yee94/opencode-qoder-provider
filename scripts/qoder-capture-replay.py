#!/usr/bin/env python3
"""
Qoder Request Capture & Replay - Working Version

This script:
1. Captures a fresh qodercli request via mitmproxy
2. Derives the alphabet using known-plaintext attack
3. Decodes the request
4. Asks for user input
5. Re-encodes with the same alphabet
6. Sends the modified request

Usage:
    python3 scripts/qoder-capture-replay.py "Your question"
"""

import subprocess
import sys
import os
import time
import json
import base64
from collections import Counter

# Known alphabet from previous analysis
KNOWN_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

def decode_with_alphabet(encoded, alphabet):
    """Decode custom base64 with given alphabet"""
    trans = str.maketrans(alphabet, STANDARD_BASE64)
    translated = encoded.translate(trans)
    padding = (4 - len(translated) % 4) % 4
    translated += '=' * padding
    return base64.b64decode(translated).decode('utf-8')

def encode_with_alphabet(plaintext, alphabet):
    """Encode to custom base64 with given alphabet"""
    encoded = base64.b64encode(plaintext.encode()).decode().rstrip('=')
    trans = str.maketrans(STANDARD_BASE64, alphabet)
    return encoded.translate(trans)

def derive_alphabet(encoded_body, known_plaintext_sample):
    """
    Derive the custom alphabet using known plaintext attack.

    We know what the plaintext should be (from previous decoded request),
    and we have the encoded form. We can derive the mapping.
    """
    # Encode the known plaintext to standard base64
    sample_b64 = base64.b64encode(known_plaintext_sample.encode()).decode().rstrip('=')

    # Find where this sample appears in the encoded body
    # Try different offsets
    best_match = None
    best_offset = 0
    best_score = 0

    for offset in range(0, min(1000, len(encoded_body) - len(sample_b64))):
        encoded_sample = encoded_body[offset:offset + len(sample_b64)]

        # Count character correspondences
        mapping = {}
        conflicts = 0
        for std_char, enc_char in zip(sample_b64, encoded_sample):
            if enc_char in mapping:
                if mapping[enc_char] != std_char:
                    conflicts += 1
            else:
                mapping[enc_char] = std_char

        score = len(mapping) - conflicts * 2
        if score > best_score:
            best_score = score
            best_match = mapping
            best_offset = offset

    if best_score < len(sample_b64) * 0.8:
        print(f"⚠ Low confidence match (score: {best_score}/{len(sample_b64)})")
        return None

    print(f"✓ Found alphabet at offset {best_offset} (score: {best_score}/{len(sample_b64)})")

    # Build the alphabet
    # We have a partial mapping: enc_char -> std_base64_char
    # Need to fill in the rest using frequency analysis

    # First, build what we know
    enc_to_std = best_match

    # Use frequency analysis for the rest
    freq = Counter(encoded_body)
    sorted_enc = [c for c, _ in freq.most_common(64)]

    # Map remaining chars by frequency
    used_std = set(enc_to_std.values())
    used_enc = set(enc_to_std.keys())

    remaining_std = [c for c in STANDARD_BASE64 if c not in used_std]
    remaining_enc = [c for c in sorted_enc if c not in used_enc]

    for enc, std in zip(remaining_enc, remaining_std):
        enc_to_std[enc] = std

    # Build the custom alphabet
    custom_alphabet = [''] * 64
    for enc_char, std_char in enc_to_std.items():
        std_idx = STANDARD_BASE64.index(std_char)
        custom_alphabet[std_idx] = enc_char

    return ''.join(custom_alphabet)

def capture_fresh_request():
    """Capture a fresh qodercli request via mitmproxy"""
    print("📡 Starting mitmdump...")

    capture_dir = "/tmp/qoder-replay-capture"
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

    # Wait for request to complete
    time.sleep(8)

    # Extract request
    print("\n📥 Extracting captured request...")

    extract_script = '''
import json
import sys

def request(flow):
    if 'qoder.sh' in flow.request.pretty_url and 'agent_chat_generation' in flow.request.pretty_url:
        with open('/tmp/qoder_replay_body.bin', 'wb') as f:
            f.write(flow.request.content)

        with open('/tmp/qoder_replay_headers.json', 'w') as f:
            json.dump(dict(flow.request.headers), f, indent=2)

        print(f"✓ Captured request ({len(flow.request.content)} bytes)")
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

    if not os.path.exists('/tmp/qoder_replay_body.bin'):
        print("❌ Failed to capture request")
        return False

    print(f"✓ Request captured")
    print(f"  Body: {os.path.getsize('/tmp/qoder_replay_body.bin')} bytes")
    print(f"  Headers: /tmp/qoder_replay_headers.json")

    return True

def derive_alphabet_from_captures():
    """Derive alphabet by comparing fresh capture with known decode"""
    print("\n🔬 Deriving alphabet...")

    # Load fresh capture
    with open('/tmp/qoder_replay_body.bin', 'r') as f:
        fresh_encoded = f.read().strip()

    # Load old capture (which we know the alphabet for)
    with open('/tmp/qoder_request_3.bin', 'r') as f:
        old_encoded = f.read().strip()

    # Decode old capture
    old_decoded = decode_with_alphabet(old_encoded, KNOWN_ALPHABET)

    # Find JSON in old decoded
    json_start = old_decoded.find('{"request_id"')
    if json_start < 0:
        json_start = old_decoded.find('{"')
        if json_start < 0:
            print("✗ Could not find JSON in old capture")
            return None

    old_json = old_decoded[json_start:]

    # Use first 100 chars of JSON as known plaintext
    known_sample = old_json[:100]
    print(f"Known sample: {known_sample[:50]}...")

    # Find where this pattern appears in fresh capture
    # The fresh capture should have similar JSON structure

    # Encode known sample to base64
    sample_b64 = base64.b64encode(known_sample.encode()).decode().rstrip('=')
    print(f"Sample base64: {sample_b64[:40]}...")

    # Find matching pattern in fresh encoded
    # Build mapping from character correspondences
    mapping = {}

    # Try to find the best alignment
    best_alignment = None
    for offset in range(0, min(500, len(fresh_encoded))):
        mapping_attempt = {}
        valid = True

        for i, (std_char, enc_char) in enumerate(zip(sample_b64, fresh_encoded[offset:])):
            if enc_char in mapping_attempt:
                if mapping_attempt[enc_char] != std_char:
                    valid = False
                    break
            else:
                mapping_attempt[enc_char] = std_char

        if valid and len(mapping_attempt) > len(sample_b64) * 0.8:
            best_alignment = (offset, mapping_attempt)
            break

    if best_alignment:
        offset, mapping = best_alignment
        print(f"✓ Found alignment at offset {offset}")
        print(f"  Mapped {len(mapping)} characters")

        # Fill in missing mappings using frequency analysis
        freq = Counter(fresh_encoded)
        sorted_enc = [c for c, _ in freq.most_common(64)]

        used_std = set(mapping.values())
        used_enc = set(mapping.keys())

        remaining_std = [c for c in STANDARD_BASE64 if c not in used_std]
        remaining_enc = [c for c in sorted_enc if c not in used_enc]

        for enc, std in zip(remaining_enc, remaining_std):
            mapping[enc] = std

        # Build alphabet
        alphabet = [''] * 64
        for enc_char, std_char in mapping.items():
            std_idx = STANDARD_BASE64.index(std_char)
            alphabet[std_idx] = enc_char

        return ''.join(alphabet)
    else:
        print("✗ Could not find alignment")
        return None

def main():
    print("=== Qoder Request Capture & Replay ===\n")

    user_message = sys.argv[1] if len(sys.argv) > 1 else None
    if not user_message:
        print("Usage: python3 scripts/qoder-capture-replay.py \"Your question\"")
        sys.exit(1)

    # Step 1: Capture fresh request
    if not capture_fresh_request():
        sys.exit(1)

    # Step 2: Derive alphabet
    alphabet = derive_alphabet_from_captures()
    if not alphabet:
        print("✗ Failed to derive alphabet")
        sys.exit(1)

    print(f"\n✓ Derived alphabet: {alphabet}")

    # Save alphabet
    with open('/tmp/qoder_replay_alphabet.txt', 'w') as f:
        f.write(alphabet)

    # Step 3: Decode fresh request
    print("\n🔓 Decoding request...")
    with open('/tmp/qoder_replay_body.bin', 'r') as f:
        fresh_encoded = f.read().strip()

    try:
        decoded = decode_with_alphabet(fresh_encoded, alphabet)
        print(f"✓ Decoded ({len(decoded)} bytes)")

        # Find and parse JSON
        json_start = decoded.find('{"request_id"')
        if json_start < 0:
            json_start = decoded.find('{"')

        if json_start >= 0:
            # Extract JSON
            import re
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

            if json_end:
                json_text = decoded[json_start:json_end]
                request = json.loads(json_text)
                print(f"✓ Parsed request")
                print(f"  Messages: {len(request['messages'])}")
                print(f"  Model: {request.get('model_config', {}).get('key', 'unknown')}")

                # Step 4: Modify request
                print(f"\n✏️  Modifying request...")

                # Replace user message
                replaced = False
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

                # Update request IDs
                import uuid
                request['request_id'] = str(uuid.uuid4())
                request['request_set_id'] = str(uuid.uuid4())
                request['chat_record_id'] = request['request_id']

                # Step 5: Re-encode
                print("\n🔒 Re-encoding...")
                new_json = json.dumps(request, ensure_ascii=False)
                new_encoded = encode_with_alphabet(new_json, alphabet)
                print(f"✓ Encoded ({len(new_encoded)} bytes)")

                # Save for debugging
                with open('/tmp/qoder_replay_decoded.json', 'w') as f:
                    json.dump(request, f, indent=2, ensure_ascii=False)
                print(f"✓ Decoded JSON saved")

                # Step 6: Load headers and update
                print("\n📡 Preparing headers...")
                with open('/tmp/qoder_replay_headers.json', 'r') as f:
                    headers = json.load(f)

                timestamp = int(time.time())
                headers['cosy-date'] = str(timestamp)
                headers['content-length'] = str(len(new_encoded))

                # Remove content-encoding if present
                headers.pop('content-encoding', None)

                # Step 7: Send request
                print("\n🚀 Sending request...\n")
                print("─" * 80)

                url = 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'

                import urllib.request
                import urllib.error

                req = urllib.request.Request(
                    url,
                    data=new_encoded.encode('ascii'),
                    headers=headers,
                    method='POST'
                )

                try:
                    with urllib.request.urlopen(req) as response:
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

                        print(f"\n\n✓ Complete response: {len(full_response)} chars")

                except urllib.error.HTTPError as e:
                    error_body = e.read().decode('utf-8', errors='replace')
                    print(f"\n❌ HTTP Error {e.code}: {error_body}")

            else:
                print("✗ Could not find JSON end")
        else:
            print("✗ Could not find JSON start")

    except Exception as e:
        print(f"✗ Error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    main()
