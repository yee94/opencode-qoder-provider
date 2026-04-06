#!/usr/bin/env node
/**
 * Hook JWT token generation in qodercli
 * 
 * This script intercepts the creation of COSY JWT tokens to understand:
 * 1. How the signature is computed
 * 2. How the info field is encrypted
 * 3. What inputs are used
 */

const script = `
// Search for strings related to JWT generation
const targets = [
  'Bearer COSY.',
  'cosyVersion',
  'requestId',
  'panic in Signature'
];

// Find module base
const qodercli = Process.enumerateModules().find(m => m.name.includes('qodercli'));
console.log('[*] qodercli module:', qodercli.name);
console.log('[*] Base address:', qodercli.base);
console.log('[*] Size:', qodercli.size);

// Search for string references in memory
function findStringReferences(str) {
  console.log('\\n[*] Searching for string: "' + str + '"');
  const matches = Memory.scan(qodercli.base, qodercli.size, str, {
    onMatch: function(address, size) {
      console.log('  Found at:', address, '->', address.readUtf8String());
      
      // Try to find cross-references to this address
      // This would tell us which function uses this string
    },
    onError: function(error) {
      console.log('  Error:', error);
    }
  });
  
  return matches;
}

// Hook HTTP request preparation (where headers are built)
// Look for functions that might build the Authorization header
Interceptor.attach(Module.findExportByName(null, 'CFNetworkCopySystemProxySettings'), {
  onEnter: function(args) {
    console.log('\\n[HTTP] Proxy settings query');
  }
});

// Hook crypto functions
const cryptoFuncs = [
  'CCCrypt',           // CommonCrypt
  'CCCryptorCreate',
  'EVP_EncryptInit',   // OpenSSL
  'EVP_DigestInit',    // Digest/Hash
];

cryptoFuncs.forEach(funcName => {
  const funcAddr = Module.findExportByName(null, funcName);
  if (funcAddr) {
    console.log('[*] Found crypto function:', funcName, 'at', funcAddr);
    
    Interceptor.attach(funcAddr, {
      onEnter: function(args) {
        console.log('\\n[CRYPTO] ' + funcName + ' called');
        console.log('  arg0:', args[0]);
        console.log('  arg1:', args[1]);
        if (args[2]) {
          console.log('  arg2 (possible key):', hexdump(args[2], { length: 32 }));
        }
      },
      onLeave: function(retval) {
        console.log('  Return:', retval);
      }
    });
  }
});

// Hook Go runtime to find string creation
// The JWT is likely built using Go's fmt.Sprintf or similar
const runtimeFuncs = [
  'runtime.concatstring2',
  'runtime.rawstring',
  'runtime.mallocgc'
];

runtimeFuncs.forEach(funcName => {
  // These are internal Go functions, may not be exported
  const patterns = Memory.scanSync(qodercli.base, qodercli.size, funcName);
  if (patterns.length > 0) {
    console.log('[*] Found Go runtime pattern:', funcName, 'count:', patterns.length);
  }
});

// Monitor network write operations (where the JWT is sent)
const writeFuncs = ['write', 'send', 'SSL_write'];
writeFuncs.forEach(funcName => {
  const funcAddr = Module.findExportByName(null, funcName);
  if (funcAddr) {
    Interceptor.attach(funcAddr, {
      onEnter: function(args) {
        const buf = args[1];
        const len = args[2].toInt32();
        
        // Check if this contains Authorization header
        try {
          const data = buf.readUtf8String(Math.min(len, 2000));
          if (data.includes('COSY.') || data.includes('Authorization')) {
            console.log('\\n[NETWORK] ' + funcName + ' with JWT:');
            console.log(data.substring(0, 500));
          }
        } catch (e) {
          // Not a string, skip
        }
      }
    });
  }
});

console.log('\\n[*] Hooks installed. Waiting for qodercli to make requests...');
console.log('[*] Trigger a request in qodercli to see JWT generation\\n');
`;

console.log('Frida JWT Analysis Script');
console.log('=========================');
console.log('');
console.log('This script should be run with:');
console.log('  frida -l scripts/frida-jwt-analysis.js -f qodercli');
console.log('');
console.log('Script content:');
console.log(script);

// Save to file
import { writeFileSync } from 'fs';
writeFileSync('/Users/yee.wang/Code/github/opencode-qoder-provider/scripts/frida-jwt-analysis.js', script);
console.log('\\nSaved to: scripts/frida-jwt-analysis.js');
