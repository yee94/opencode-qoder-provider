#!/usr/bin/env python3
"""
Qoder Request Capture Script

Captures the next qodercli request via mitmdump proxy, extracts and decodes it.

Usage:
    python3 scripts/qoder-capture.py
"""

import subprocess
import sys
import time
import json
import os
import signal

# Custom alphabet from previous successful decode
CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

def decode_custom_base64(ciphertext):
    """Decode using custom base64 alphabet"""
    trans_table = str.maketrans(CUSTOM_ALPHABET, STANDARD_BASE64)
    translated = ciphertext.translate(trans_table)
    padding = (4 - len(translated) % 4) % 4
    translated += '=' * padding
    
    import base64
    decoded_bytes = base64.b64decode(translated)
    return decoded_bytes.decode('utf-8')

def extract_request_json(decoded_text):
    """Extract the request JSON from decoded text"""
    # Find "request_id" which marks the start of the actual request
    request_id_pos = decoded_text.find('"request_id"')
    if request_id_pos < 0:
        print("✗ Could not find request_id in decoded text")
        return None
    
    # Find the { before it
    json_start = decoded_text.rfind('{', 0, request_id_pos)
    if json_start < 0:
        json_start = request_id_pos
    
    json_content = decoded_text[json_start:]
    
    # Find the matching } by trying to parse from the end backwards
    for trim in range(0, 2000):
        try:
            candidate = json_content[:len(json_content)-trim].rstrip()
            if not candidate.endswith('}'):
                continue
            
            parsed = json.loads(candidate)
            print(f"✓ Found valid JSON at length {len(candidate)}")
            print(f"  Keys: {list(parsed.keys())}")
            if 'messages' in parsed:
                print(f"  Messages: {len(parsed['messages'])}")
            return parsed
        except json.JSONDecodeError:
            continue
    
    print("✗ Could not extract valid JSON")
    return None

def main():
    print("=== Qoder Request Capture ===\n")
    
    capture_dir = "/tmp/qoder-fresh-capture"
    os.makedirs(capture_dir, exist_ok=True)
    
    body_file = os.path.join(capture_dir, "request_body.bin")
    headers_file = os.path.join(capture_dir, "headers.json")
    
    # Step 1: Start mitmdump
    print("📡 Starting mitmdump...")
    mitm_proc = subprocess.Popen([
        'mitmdump',
        '-w', os.path.join(capture_dir, 'flows'),
        '--set', 'flow_detail=0',
        '--mode', 'regular'
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    time.sleep(2)
    print(f"✓ mitmdump started (PID: {mitm_proc.pid})")
    
    # Step 2: Run qodercli with proxy
    print("\n🔨 Running qodercli -p 'test'...")
    env = os.environ.copy()
    env['HTTPS_PROXY'] = 'http://127.0.0.1:8080'
    env['HTTP_PROXY'] = 'http://127.0.0.1:8080'
    
    qoder_proc = subprocess.Popen(
        ['qodercli', '-p', 'test'],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    
    # Wait for request to complete
    time.sleep(8)
    
    # Step 3: Extract from flows using mitmdump
    print("\n📥 Extracting request...")
    
    extract_script = f'''
import json
import sys

def request(flow):
    if 'qoder.sh' in flow.request.pretty_url and 'agent_chat_generation' in flow.request.pretty_url:
        with open('{body_file}', 'wb') as f:
            f.write(flow.request.content)
        
        headers = dict(flow.request.headers)
        with open('{headers_file}', 'w') as f:
            json.dump(headers, f, indent=2)
        
        print(f"✓ Captured request")
        print(f"  Body: {{len(flow.request.content)}} bytes")
        print(f"  Headers: {{len(headers)}} fields")
        sys.exit(0)
'''
    
    with open(os.path.join(capture_dir, 'extract.py'), 'w') as f:
        f.write(extract_script)
    
    result = subprocess.run([
        'mitmdump',
        '-nr', os.path.join(capture_dir, 'flows'),
        '--script', os.path.join(capture_dir, 'extract.py')
    ], capture_output=True, text=True)
    
    print(result.stdout)
    if result.stderr:
        print(result.stderr)
    
    # Cleanup
    print("\n🧹 Stopping mitmdump...")
    mitm_proc.terminate()
    try:
        mitm_proc.wait(timeout=5)
    except:
        mitm_proc.kill()
    
    qoder_proc.terminate()
    
    # Check if we captured anything
    if not os.path.exists(body_file):
        print("\n❌ Failed to capture request")
        print("Make sure qodercli is installed and logged in")
        return False
    
    print(f"\n✓ Request captured!")
    print(f"  Body: {body_file} ({os.path.getsize(body_file)} bytes)")
    print(f"  Headers: {headers_file}")
    
    # Decode
    print("\n🔓 Decoding request...")
    with open(body_file, 'r') as f:
        encoded_body = f.read().strip()
    
    try:
        decoded = decode_custom_base64(encoded_body)
        print(f"✓ Decoded ({len(decoded)} bytes)")
        
        # Extract JSON
        print("\n📝 Extracting request JSON...")
        request_json = extract_request_json(decoded)
        
        if request_json:
            output_file = '/tmp/valid_request.json'
            with open(output_file, 'w') as f:
                json.dump(request_json, f, indent=2, ensure_ascii=False)
            print(f"\n✓ Saved to {output_file}")
            
            # Copy headers too
            import shutil
            shutil.copy2(headers_file, '/tmp/qoder_headers_latest.json')
            print(f"✓ Headers copied to /tmp/qoder_headers_latest.json")
            
            return True
        
    except Exception as e:
        print(f"✗ Decode failed: {e}")
        return False
    
    return False

if __name__ == '__main__':
    success = main()
    sys.exit(0 if success else 1)
