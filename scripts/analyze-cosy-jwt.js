#!/usr/bin/env node
/**
 * Analyze the captured authorization JWT
 */

const capturedAuth = 'Bearer COSY.eyJjb3N5VmVyc2lvbiI6IjAuMS4zOCIsImlkZVZlcnNpb24iOiIiLCJpbmZvIjoieWdxU2s2RTlZZEtTWWoxaWhKSTg5MTRZNnA2ekw0aWF6bFl4L0pRWWRJZUxoRU5mN0htbXJWQUhacWQ5SWtJSzVaSUtMNG42TmhUSWh4bjM3THN1ZEphcWVRTDFYUjJNYlRVTk14a1gwUkRWeUdEc2Z6K3BBZnJxM245YkZKeXpIMGF3NTJUZFgrTml3SWtNZFRxZnNoY2o1dm1XdytESXM0Q2hQNUhETlRtUDAzV09oNzA3OFIzS2pzOEZrSXdPbk43emZEYzltV1ZMOHY4cXA2Zm9GZGVzTWxkd0dvTU1xTHFkR1JUR25RVzc4MGlxNVUwMnBjUlNYa3drMVlxZUJQSjZzR2YyTnFpdVVnV1lCanhyN1d1bCtHdXFCWWxBM2tTSFJyQTI1SytlenRJUzVQanI4Mkk2MmVJdGJVeXNDbStKQUhrTWJtOVprWmowdlFRUjIvbmsxVkRrd2g0WUtQZXVxT0YwbnRKUjcvN2VqcFFhZDRZS2xZRm9MOCs0SXQvVWdMR3F0a1lSamMvQWl4SnBoK2JyYmYvZW01YUp3OWk3TUdNSVN6clVSZHpSSHZGSjdVWFRLQ0tBbWVxNyIsInJlcXVlc3RJZCI6ImYwNWUyYmViLTY0YjEtNGM4NC1hYzYxLTIyMzYzZDI1MmJiYSIsInZlcnNpb24iOiJ2MSJ9.06cec1f722a2900d8afe5d3097b8b256';

const token = capturedAuth.replace('Bearer ', '');
const parts = token.split('.');

console.log('COSY JWT Structure:');
console.log(`Parts: ${parts.length}`);
console.log(`Prefix: ${parts[0]}`);
console.log(`Payload (base64): ${parts[1].substring(0, 50)}...`);
console.log(`Signature: ${parts[2]}\n`);

// Decode the payload
try {
  const decoded = Buffer.from(parts[1], 'base64').toString('utf-8');
  const payload = JSON.parse(decoded);
  
  console.log('Decoded JWT Payload:');
  console.log(JSON.stringify(payload, null, 2));
  
  console.log('\nKey observations:');
  console.log(`- cosyVersion: ${payload.cosyVersion}`);
  console.log(`- requestId: ${payload.requestId}`);
  console.log(`- version: ${payload.version}`);
  console.log(`- info length: ${payload.info?.length || 0}`);
  console.log(`- info preview: ${payload.info?.substring(0, 50)}...`);
  
} catch (err) {
  console.log(`Decode error: ${err.message}`);
}
