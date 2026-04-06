#!/usr/bin/env node
/**
 * Qoder Direct Request - Runtime Hook Version
 *
 * Uses Frida to hook qodercli's alphabet generation, extract the alphabet,
 * then immediately send a modified request.
 *
 * Prerequisites:
 *   - frida-server running on device (for iOS/Android) OR
 *   - Use on macOS with debug build
 *
 * Alternative: Use GDB/LLDB to extract alphabet from memory
 *
 * Since Frida is complex to set up, this script falls back to a simpler approach:
 * 1. Patch qodercli to print the alphabet to a file
 * 2. Run qodercli with a test message
 * 3. Read the alphabet
 * 4. Use it to encode/decode requests
 */

import * as fs from 'fs';
import { execSync, spawn } from 'child_process';

// ── Configuration ─────────────────────────────────────────────────────────────

const QODERCLI_PATH = '/Users/yee.wang/.local/bin/qodercli';
const ALPHABET_FILE = '/tmp/qoder_alphabet.txt';

// ── Step 1: Find Alphabet in Binary ───────────────────────────────────────────

function findAlphabetInBinary() {
  console.error('🔍 Searching for alphabets in qodercli binary...');

  const binary = fs.readFileSync(QODERCLI_PATH);
  const binaryStr = binary.toString('binary');

  // Find all 64-character sequences that look like base64 alphabets
  const charset = /[A-Za-z0-9+\/,._@!#$%^&*()\-]/;
  const alphabets = [];

  let i = 0;
  while (i < binaryStr.length) {
    // Look for start of a 64-char sequence
    let start = i;
    while (i < binaryStr.length && charset.test(binaryStr[i])) {
      i++;
    }

    if (i - start === 64) {
      const candidate = binaryStr.substring(start, i);
      const unique = new Set(candidate).size;

      if (unique >= 60) { // Allow some duplicates
        alphabets.push({
          position: start,
          alphabet: candidate,
          unique,
        });
      }
    }

    i++;
  }

  console.error(`  Found ${alphabets.length} candidate alphabets`);

  if (alphabets.length > 0) {
    // The known alphabet should be in the list
    const known = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
    const knownAlpha = alphabets.find(a => a.alphabet === known);

    if (knownAlpha) {
      console.error(`  ✓ Known alphabet found at 0x${knownAlpha.position.toString(16)}`);
    }

    return alphabets;
  }

  return [];
}

// ── Step 2: Patch Binary to Print Alphabet ────────────────────────────────────

function patchBinaryToPrintAlphabet() {
  console.error('\n⚠ This would modify the qodercli binary to dump the alphabet at runtime');
  console.error('  Skipping - too risky to modify production binary');
  console.error('  Alternative: Use GDB/LLDB to read memory at runtime');
  return false;
}

// ── Step 3: Use GDB/LLDB to Extract Alphabet ──────────────────────────────────

function extractAlphabetWithDebugger() {
  console.error('\n🔧 Attempting to extract alphabet using lldb...');

  // This is a proof-of-concept - in reality, you'd need to:
  // 1. Start qodercli under lldb
  // 2. Set breakpoint at alphabet usage
  // 3. Read memory at the alphabet address
  // 4. Continue execution

  const knownPosition = 0x20d5720;

  // Check if we can just read the binary at that position
  try {
    const binary = fs.readFileSync(QODERCLI_PATH);
    const alphabet = binary.subarray(knownPosition, knownPosition + 64).toString('ascii');

    console.error(`  Read ${alphabet.length} bytes from 0x${knownPosition.toString(16)}`);
    console.error(`  Alphabet: ${alphabet}`);

    // Verify it looks like a valid alphabet
    if (new Set(alphabet).size >= 60 && alphabet.length === 64) {
      fs.writeFileSync(ALPHABET_FILE, alphabet);
      console.error(`  ✓ Alphabet saved to ${ALPHABET_FILE}`);
      return alphabet;
    }
  } catch (e) {
    console.error(`  ✗ Failed: ${e.message}`);
  }

  return null;
}

// ── Step 4: Derive Alphabet from Captured Request ─────────────────────────────

function deriveAlphabetFromCapture(encodedBody) {
  console.error('\n🔬 Deriving alphabet from captured request using frequency analysis...');

  const KNOWN_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
  const STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  // Count character frequencies in the captured body
  const freq = new Map();
  for (const char of encodedBody) {
    freq.set(char, (freq.get(char) || 0) + 1);
  }

  // Sort by frequency
  const sorted = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([char]) => char);

  console.error(`  Unique chars in capture: ${sorted.length}`);

  // This assumes the captured request has similar structure to previous ones
  // so character frequencies should be similar
  // Map: most frequent in capture -> most frequent in known alphabet usage

  // Load a previous capture for comparison
  const oldBodyPath = '/tmp/qoder_request_3.bin';
  if (fs.existsSync(oldBodyPath)) {
    const oldBody = fs.readFileSync(oldBodyPath, 'ascii');
    const oldFreq = new Map();
    for (const char of oldBody) {
      oldFreq.set(char, (oldFreq.get(char) || 0) + 1);
    }
    const oldSorted = Array.from(oldFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([char]) => char);

    // Map by frequency rank
    const mapping = new Map();
    for (let i = 0; i < Math.min(sorted.length, oldSorted.length); i++) {
      mapping.set(sorted[i], oldSorted[i]);
    }

    console.error(`  Mapped ${mapping.size} characters by frequency`);

    // Now decode the captured body using this mapping
    let decoded = '';
    for (const char of encodedBody) {
      const mapped = mapping.get(char) || char;
      decoded += mapped;
    }

    // Try to parse as if it were encoded with the known alphabet
    try {
      const transTable = new Map();
      for (let i = 0; i < KNOWN_ALPHABET.length; i++) {
        transTable.set(KNOWN_ALPHABET[i], STANDARD_BASE64[i]);
      }

      const translated = decoded.split('').map(c => transTable.get(c) || c).join('');
      const padding = (4 - translated.length % 4) % 4;
      const padded = translated + '='.repeat(padding);
      const decodedBytes = Buffer.from(padded, 'base64');
      const decodedText = decodedBytes.toString('utf-8');

      if (decodedText.includes('"request_id"') || decodedText.includes('"messages"')) {
        console.error('  ✓ Successfully decoded!');
        return decodedText;
      }
    } catch (e) {
      console.error(`  ✗ Decode failed: ${e.message}`);
    }
  }

  return null;
}

// ── Main Execution ────────────────────────────────────────────────────────────

async function main() {
  console.error('=== Qoder Direct Request - Alphabet Extraction ===\n');

  // Try static extraction first
  let alphabet = extractAlphabetWithDebugger();

  if (!alphabet) {
    console.error('\n⚠ Could not extract alphabet from binary');
    console.error('  The alphabet at 0x20d5720 may be shuffled at runtime');
    console.error('\n  Options:');
    console.error('  1. Use a captured request and derive alphabet (frequency analysis)');
    console.error('  2. Hook runtime with Frida/GDB');
    console.error('  3. Patch binary to dump alphabet (risky)');

    // Check if we have a captured request
    const capturePath = '/tmp/qoder-fresh-capture/request_body.bin';
    if (fs.existsSync(capturePath)) {
      console.error('\n  Found fresh capture - attempting frequency analysis...');
      const encodedBody = fs.readFileSync(capturePath, 'ascii');
      const decoded = deriveAlphabetFromCapture(encodedBody);

      if (decoded) {
        console.error('\n  ✓ Decoded using frequency analysis!');
        console.error(`  First 200 chars: ${decoded.substring(0, 200)}`);
      }
    }
  }

  if (alphabet) {
    console.error(`\n✓ Alphabet: ${alphabet}`);
    console.error('\n  You can now use this alphabet to encode/decode requests');
    console.error(`  Saved to: ${ALPHABET_FILE}`);
  }
}

main().catch(console.error);
