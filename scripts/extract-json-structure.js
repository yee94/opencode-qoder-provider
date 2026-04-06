#!/usr/bin/env node
/**
 * Extract JSON by finding the end pattern
 */

import { readFileSync, writeFileSync } from 'fs';

const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STANDARD_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const charMap = {};
for (let i = 0; i < CUSTOM_ALPHABET.length; i++) {
  charMap[CUSTOM_ALPHABET[i]] = STANDARD_BASE64[i];
}

function decodeCustomBase64(encoded) {
  let standard = '';
  for (const char of encoded) {
    if (charMap[char]) {
      standard += charMap[char];
    } else if (char === '=') {
      standard += '=';
    }
  }
  return Buffer.from(standard, 'base64');
}

const encodedText = readFileSync('/tmp/forward/body.bin', 'utf8').trim();
const decodedText = decodeCustomBase64(encodedText).toString('utf8');
const jsonText = decodedText.substring(50043);

console.log('Searching for end of messages array...\n');

// Find all occurrences of '"}],' which would close a message in the array
const msgEndPattern = /"\}],/g;
let match;
const msgEnds = [];
while ((match = msgEndPattern.exec(jsonText)) !== null) {
  msgEnds.push(match.index);
  console.log(`Found message end at: ${match.index}`);
}

// Find the LAST occurrence of '"}]' or '"}]}' 
const lastMsgEnd = jsonText.lastIndexOf('"}]');
const lastMsgEnd2 = jsonText.lastIndexOf('"}]}');
const lastMsgEnd3 = jsonText.lastIndexOf('"}]}');

console.log('\nLast occurrences of message closing patterns:');
console.log('  "}]:', lastMsgEnd);
console.log('  "}]}:', lastMsgEnd2);
console.log('  "}]}:', lastMsgEnd3);

// Try to find the pattern: user message content followed by }]
// Look for the second "role":"user" and then find the closing
const userMsgStart = jsonText.lastIndexOf('"role":"user"');
console.log(`\nLast user message starts at: ${userMsgStart}`);

if (userMsgStart > 0) {
  // Extract from here and try to find the end
  const afterUser = jsonText.substring(userMsgStart);
  
  // Look for "}]} or similar patterns
  const closingPatterns = ['"}]}', '"}]\n}', '"}]}\\n', '"}]}\n'];
  
  for (const pattern of closingPatterns) {
    const idx = afterUser.indexOf(pattern);
    if (idx !== -1) {
      console.log(`\nFound closing pattern "${pattern.replace(/\n/g, '\\n')}" at offset ${userMsgStart + idx}`);
      console.log(`Context: ${afterUser.substring(Math.max(0, idx - 50), idx + 50)}`);
    }
  }
}

// Let's try a completely different approach: use regex to match the entire structure
console.log('\n\nUsing regex to extract JSON structure...');

// Match from start to first occurrence of }]
const jsonMatch = jsonText.match(/^(\{.*?"messages":\[\{.*?\}.*?\}\])/s);

if (jsonMatch) {
  console.log('Regex matched! Length:', jsonMatch[1].length);
  console.log('First 200:', jsonMatch[1].substring(0, 200));
  console.log('Last 100:', jsonMatch[1].substring(jsonMatch[1].length - 100));
  
  try {
    const parsed = JSON.parse(jsonMatch[1]);
    console.log('✓ Parsed successfully!');
    writeFileSync('/tmp/extracted-request.json', JSON.stringify(parsed, null, 2));
    console.log('Saved to /tmp/extracted-request.json');
  } catch (err) {
    console.log('✗ Parse error:', err.message);
  }
} else {
  console.log('Regex did not match');
  
  // Simpler: try to find where the JSON ends by looking for specific text patterns
  // that are definitely NOT part of JSON (like newlines followed by non-JSON text)
  const nonJsonPatterns = [/^\n[^\s\{"\[\]]/m, /\n\n\n/m];
  
  for (const pattern of nonJsonPatterns) {
    const match = pattern.exec(jsonText);
    if (match) {
      console.log(`\nFound non-JSON pattern at: ${match.index}`);
      console.log(`Context: ${jsonText.substring(match.index - 100, match.index + 50)}`);
      
      // Try parsing up to this point
      const candidate = jsonText.substring(0, match.index);
      try {
        const parsed = JSON.parse(candidate);
        console.log('✓ Parsed successfully!');
        writeFileSync('/tmp/extracted-request.json', JSON.stringify(parsed, null, 2));
        console.log('Saved to /tmp/extracted-request.json');
        break;
      } catch (err) {
        console.log('✗ Parse error:', err.message);
      }
    }
  }
}
