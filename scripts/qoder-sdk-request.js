#!/usr/bin/env node
/**
 * Qoder Direct Request - Using SDK query() function
 * 
 * The simplest approach: use the existing QoderAgentSDK query() function which already
 * handles all encryption, authentication, and request formatting.
 * 
 * Usage: node scripts/qoder-sdk-request.js "Your message"
 */

import {
  configure,
  query,
} from '../src/vendor/qoder-agent-sdk.mjs';

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ── Resolve storage directory ────────────────────────────────────────────────

function resolveStorageDir() {
  const candidates = [
    path.join(os.homedir(), '.qoder'),
    path.join(os.homedir(), '.qoderwork'),
  ];
  let best;
  let bestMtime = 0;
  for (const dir of candidates) {
    const userFile = path.join(dir, '.auth', 'user');
    try {
      const stat = fs.statSync(userFile);
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        best = dir;
      }
    } catch { /* file doesn't exist */ }
  }
  return best ?? path.join(os.homedir(), '.qoder');
}

// ── Configure SDK ─────────────────────────────────────────────────────────────

const storageDir = resolveStorageDir();
console.error(`📁 Using storage: ${storageDir}`);

configure({
  storageDir,
});

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const userMessage = process.argv[2];
  const model = process.argv[4] === '--model' ? process.argv[5] : 'efficient';

  if (!userMessage) {
    console.error('Usage: node scripts/qoder-sdk-request.js "Your message" [--model <name>]');
    process.exit(1);
  }

  console.error(`\n=== Qoder Direct Request (SDK) ===\n`);
  console.error(`📝 Message: "${userMessage}"`);
  console.error(`🤖 Model: ${model}\n`);

  // Use standalone query function
  const result = query({
    prompt: userMessage,
    model,
  });

  console.error('✅ Query started\n');
  console.error('─'.repeat(80));

  // Read from the result stream - SDK returns SDKMessage objects
  for await (const message of result) {
    if (message.type === 'assistant' && message.message?.content) {
      // Extract text content
      for (const block of message.message.content) {
        if (block.type === 'text') {
          process.stdout.write(block.text);
        }
      }
    }
  }

  console.error('\n\n' + '─'.repeat(80));
  console.error(`\n✨ Complete`);
}

main().catch(err => {
  console.error(`\n❌ Error: ${err.message}`);
  if (process.env.QODER_DEBUG === '1') {
    console.error(err.stack);
  }
  process.exit(1);
});
