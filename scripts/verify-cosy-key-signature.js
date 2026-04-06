#!/usr/bin/env node
/**
 * Verify if cosy-key is used to sign the JWT
 * 
 * This script tests various MD5/HMAC combinations to see if any
 * produces the same signature as the captured JWT.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';

// Captured values
const capturedJwt = 'COSY.eyJjb3N5VmVyc2lvbiI6IjAuMS4zOCIsImlkZVZlcnNpb24iOiIiLCJpbmZvIjoieWdxU2s2RTlZZEtTWWoxaWhKSTg5MTRZNnA2ekw0aWF6bFl4L0pRWWRJZUxoRU5mN0htbXJWQUhacWQ5SWtJSzVaSUtMNG42TmhUSWh4bjM3THN1ZEphcWVRTDFYUjJNYlRVTk14a1gwUkRWeUdEc2Z6K3BBZnJxM245YkZKeXpIMGF3NTJUZFgrTml3SWtNZFRxZnNoY2o1dm1XdytESXM0Q2hQNUhETlRtUDAzV09oNzA3OFIzS2pzOEZrSXdPbk43emZEYzltV1ZMOHY4cXA2Zm9GZGVzTWxkd0dvTU1xTHFkR1JUR25RVzc4MGlxNVUwMnBjUlNYa3drMVlxZUJQSjZzR2YyTnFpdVVnV1lCanhyN1d1bCtHdXFCWWxBM2tTSFJyQTI1SytlenRJUzVQanI4Mkk2MmVJdGJVeXNDbStKQUhrTWJtOVprWmowdlFRUjIvbmsxVkRrd2g0WUtQZXVxT0YwbnRKUjcvN2VqcFFhZDRZS2xZRm9MOCs0SXQvVWdMR3F0a1lSamMvQWl4SnBoK2JyYmYvZW01YUp3OWk3TUdNSVN6clVSZHpSSHZGSjdVWFRLQ0tBbWVxNyIsInJlcXVlc3RJZCI6ImYwNWUyYmViLTY0YjEtNGM4NC1hYzYxLTIyMzYzZDI1MmJiYSIsInZlcnNpb24iOiJ2MSJ9.06cec1f722a2900d8afe5d3097b8b256';

const headers = JSON.parse(fs.readFileSync('/tmp/forward/headers.json', 'utf8'));
const cosyKey = headers['cosy-key'];
const cosyDate = headers['cosy-date'];

console.log('=== JWT Signature Verification ===\n');

// Parse JWT
const parts = capturedJwt.replace('Bearer ', '').split('.');
const prefix = parts[0]; // COSY
const payloadBase64 = parts[1];
const capturedSignature = parts[2]; // 06cec1f722a2900d8afe5d3097b8b256

console.log('JWT Structure:');
console.log(`  Prefix: ${prefix}`);
console.log(`  Payload length: ${payloadBase64.length} chars`);
console.log(`  Captured signature: ${capturedSignature}`);
console.log(`  Cosy-Key: ${cosyKey.substring(0, 50)}...`);
console.log(`  Cosy-Date: ${cosyDate}\n`);

// Decode payload
const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf-8'));
console.log('JWT Payload:');
console.log(JSON.stringify(payload, null, 2));
console.log('');

// Decode cosy-key
const cosyKeyDecoded = Buffer.from(cosyKey, 'base64');
console.log(`Cosy-Key decoded length: ${cosyKeyDecoded.length} bytes\n`);

// Test different signature algorithms
const tests = [
  {
    name: 'MD5(payload_base64)',
    fn: () => crypto.createHash('md5').update(payloadBase64).digest('hex')
  },
  {
    name: 'MD5(COSY.payload_base64)',
    fn: () => crypto.createHash('md5').update(`${prefix}.${payloadBase64}`).digest('hex')
  },
  {
    name: 'MD5(payload_base64 + cosy_key)',
    fn: () => crypto.createHash('md5').update(payloadBase64 + cosyKey).digest('hex')
  },
  {
    name: 'MD5(COSY + payload_base64 + cosy_key)',
    fn: () => crypto.createHash('md5').update(`${prefix}${payloadBase64}${cosyKey}`).digest('hex')
  },
  {
    name: 'MD5(COSY.payload_base64 + cosy_key)',
    fn: () => crypto.createHash('md5').update(`${prefix}.${payloadBase64}${cosyKey}`).digest('hex')
  },
  {
    name: 'MD5(payload_base64 + cosy_key_decoded)',
    fn: () => crypto.createHash('md5').update(payloadBase64 + cosyKeyDecoded).digest('hex')
  },
  {
    name: 'HMAC-MD5(cosy_key, payload_base64)',
    fn: () => crypto.createHmac('md5', cosyKey).update(payloadBase64).digest('hex')
  },
  {
    name: 'HMAC-MD5(cosy_key_decoded, payload_base64)',
    fn: () => crypto.createHmac('md5', cosyKeyDecoded).update(payloadBase64).digest('hex')
  },
  {
    name: 'HMAC-MD5(cosy_key, COSY.payload_base64)',
    fn: () => crypto.createHmac('md5', cosyKey).update(`${prefix}.${payloadBase64}`).digest('hex')
  },
  {
    name: 'MD5(payload_base64 + cosy_date)',
    fn: () => crypto.createHash('md5').update(payloadBase64 + cosyDate).digest('hex')
  },
  {
    name: 'MD5(COSY.payload_base64.cosy_date)',
    fn: () => crypto.createHash('md5').update(`${prefix}.${payloadBase64}.${cosyDate}`).digest('hex')
  },
  {
    name: 'HMAC-SHA256(cosy_key, payload_base64) [truncated to 32]',
    fn: () => crypto.createHmac('sha256', cosyKey).update(payloadBase64).digest('hex').substring(0, 32)
  },
  {
    name: 'MD5(info_field + cosy_key)',
    fn: () => crypto.createHash('md5').update(payload.info + cosyKey).digest('hex')
  },
  {
    name: 'MD5(requestId + cosy_key)',
    fn: () => crypto.createHash('md5').update(payload.requestId + cosyKey).digest('hex')
  },
  {
    name: 'MD5(COSY + requestId + cosy_key)',
    fn: () => crypto.createHash('md5').update(`${prefix}${payload.requestId}${cosyKey}`).digest('hex')
  },
];

console.log('Testing signature algorithms...\n');

let found = false;
for (const test of tests) {
  const signature = test.fn();
  const match = signature === capturedSignature;
  
  console.log(`${match ? '✓' : '✗'} ${test.name}`);
  console.log(`  Result: ${signature}`);
  if (match) {
    console.log(`  *** MATCH! ***`);
    found = true;
  }
  console.log('');
}

if (found) {
  console.log('\n=== SUCCESS! Signature algorithm identified ===');
} else {
  console.log('\n=== No match found ===');
  console.log('\nPossible reasons:');
  console.log('1. Signature uses a different key (not cosy-key)');
  console.log('2. Signature algorithm is more complex (e.g., involves timestamp validation)');
  console.log('3. Info field needs to be regenerated with each request');
  console.log('4. Signature uses a server-side secret not available to us');
  
  console.log('\nExpected signature:');
  console.log(`  ${capturedSignature}`);
  
  console.log('\nClosest attempts:');
  // Show the first few attempts for reference
  tests.slice(0, 3).forEach(t => {
    console.log(`  ${t.name}: ${t.fn()}`);
  });
}

// Additional analysis: Check if signature changes with different payload
console.log('\n\n=== Payload modification test ===');

// Try creating a new payload with different requestId
const newPayload = {
  ...payload,
  requestId: crypto.randomUUID()
};

const newPayloadBase64 = Buffer.from(JSON.stringify(newPayload)).toString('base64');

// Test if any algorithm produces a valid-looking signature with new payload
console.log('\nTesting if signature algorithm is payload-dependent...');
console.log('New payload (different requestId):');
console.log(`  Original requestId: ${payload.requestId}`);
console.log(`  New requestId: ${newPayload.requestId}`);

const testSig = crypto.createHash('md5').update(newPayloadBase64 + cosyKey).digest('hex');
console.log(`\nMD5(new_payload + cosy_key): ${testSig}`);
console.log(`Original signature: ${capturedSignature}`);
console.log(`Match: ${testSig === capturedSignature ? 'YES (algorithm confirmed)' : 'NO (expected)'}`);
