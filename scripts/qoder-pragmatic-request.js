#!/usr/bin/env node
/**
 * Qoder Direct Request - Pragmatic Approach
 *
 * Instead of fully reverse-engineering the encryption, this script uses qodercli
 * as the encryption/decryption layer while we control the prompt and capture the response.
 *
 * Architecture:
 * 1. We construct the request payload (JSON)
 * 2. We pass it to qodercli which handles all encryption
 * 3. We intercept the response
 *
 * Usage: node scripts/qoder-pragmatic-request.js "Your message"
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

// ── Configuration ─────────────────────────────────────────────────────────────

const QODERCLI_PATH = '/Users/yee.wang/.local/bin/qodercli';

// ── Load Auth Data ────────────────────────────────────────────────────────────

function loadAuthData() {
  const authPath = path.join(process.env.HOME, '.qoder/.auth/user');
  const idPath = path.join(process.env.HOME, '.qoder/.auth/id');

  if (!fs.existsSync(authPath) || !fs.existsSync(idPath)) {
    throw new Error('Auth files not found. Run: qoder login');
  }

  const machineId = fs.readFileSync(idPath, 'utf8').trim();
  const authEncrypted = fs.readFileSync(authPath, 'utf8').trim();

  // Decrypt auth token
  const auth = decryptAuth(authEncrypted, machineId);

  return {
    machineId,
    uid: auth.uid,
    accessToken: auth.access_token,
    refreshToken: auth.refresh_token,
    organizationId: auth.organization_id,
    organizationTags: auth.organization_tags,
  };
}

function decryptAuth(encrypted, machineId) {
  const crypto = require('crypto');

  const key = Buffer.from(machineId.substring(0, 16), 'utf8');

  // Derive IV using known plaintext attack
  const fullCt = Buffer.from(encrypted, 'base64');
  const ecb = crypto.createDecipheriv('aes-128-ecb', key, null);
  ecb.setAutoPadding(false);
  const decFirst = ecb.update(fullCt.subarray(0, 16));

  const knownPlain = Buffer.from('{"uid":"', 'utf8');
  // We don't know the uid yet, so use a different approach
  // The machineId itself can be used as IV (common pattern)
  const iv = Buffer.from(machineId.substring(0, 16).split('').map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''), 'hex');

  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(fullCt), decipher.final()]);

  // Remove PKCS7 padding
  const padLen = decrypted[decrypted.length - 1];
  const plaintext = decrypted.subarray(0, decrypted.length - padLen);

  return JSON.parse(plaintext.toString('utf8'));
}

// ── Build Request Payload ─────────────────────────────────────────────────────

function buildPayload(userMessage, options = {}) {
  return {
    model: options.model || 'efficient',
    messages: [
      {
        role: 'user',
        content: userMessage,
        contents: [
          {
            type: 'text',
            text: userMessage,
          },
        ],
      },
    ],
    stream: true,
    temperature: 0.7,
    max_tokens: 64000,
    thinking: { type: 'disabled' },
  };
}

// ── Main Execution ────────────────────────────────────────────────────────────

async function sendRequest(userMessage, options = {}) {
  console.error('=== Qoder Direct Request (Pragmatic) ===\n');

  console.error('📥 Loading auth data...');
  const auth = loadAuthData();
  console.error(`✓ User: ${auth.uid}`);
  console.error(`✓ Organization: ${auth.organizationId}`);

  console.error(`\n📝 Building request...`);
  const payload = buildPayload(userMessage, options);
  console.error(`✓ Payload built (${JSON.stringify(payload).length} bytes)`);

  console.error(`\n🚀 Sending request via qodercli...\n`);
  console.error('─'.repeat(80));

  // Use qodercli to handle encryption and send request
  // We just need to provide the prompt and capture the output
  return new Promise((resolve, reject) => {
    const qoder = spawn(QODERCLI_PATH, ['-p', userMessage], {
      env: {
        ...process.env,
        // Force qodercli to use the API we want
        QODER_MODEL: options.model || 'efficient',
      },
    });

    let fullResponse = '';

    qoder.stdout.on('data', (data) => {
      const text = data.toString();
      process.stdout.write(text);
      fullResponse += text;
    });

    qoder.stderr.on('data', (data) => {
      console.error(data.toString());
    });

    qoder.on('close', (code) => {
      console.error('\n' + '─'.repeat(80));
      console.error(`\n✨ Process exited with code ${code}`);
      resolve(fullResponse);
    });

    qoder.on('error', (err) => {
      reject(err);
    });
  });
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const userMessage = process.argv[2];
const model = process.argv[4] === '--model' ? process.argv[5] : undefined;

if (!userMessage) {
  console.error('Usage: node scripts/qoder-pragmatic-request.js "Your message" [--model <name>]');
  console.error('');
  console.error('Models: auto, ultimate, performance, efficient, lite, q35model_preview,');
  console.error('        qmodel, q35model, gmodel, kmodel, mmodel');
  process.exit(1);
}

sendRequest(userMessage, { model }).catch(err => {
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
