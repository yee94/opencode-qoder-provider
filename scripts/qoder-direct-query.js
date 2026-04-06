#!/usr/bin/env node
/**
 * Qoder Direct Query - Uses vendored SDK directly
 * 
 * This bypasses the opencode plugin layer and calls the Qoder SDK directly.
 * No subprocess spawning, no HTTP reverse engineering needed.
 * 
 * Usage:
 *   node scripts/qoder-direct-query.js "What is 2+2?"
 *   node scripts/qoder-direct-query.js --model efficient "Explain Go calling convention"
 *   node scripts/qoder-direct-query.js --model auto "Write a haiku about code"
 */

import { configure, query } from '../src/vendor/qoder-agent-sdk.mjs';
import * as path from 'path';
import * as os from 'os';

// ── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'efficient';

function parseArgs(argv) {
    const args = {
        model: DEFAULT_MODEL,
        message: '',
    };
    
    let messageStart = -1;
    
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--model') {
            args.model = argv[++i];
        } else {
            if (messageStart === -1) messageStart = i;
        }
    }
    
    if (messageStart === -1) {
        console.error('Usage: node qoder-direct-query.js [--model <model>] <message>');
        console.error('');
        console.error('Available models:');
        console.error('  auto          - Auto (1.0x)');
        console.error('  efficient     - Efficient (0.3x) [default]');
        console.error('  performance   - Performance (1.1x)');
        console.error('  ultimate      - Ultimate (1.6x, reasoning)');
        console.error('  lite          - Lite (free)');
        console.error('  qmodel        - Qwen3.6-Plus (0.2x)');
        console.error('  q35model      - Qwen3.5-Plus (0.2x)');
        console.error('  gmodel        - GLM-5 (0.5x)');
        console.error('  kmodel        - Kimi-K2.5 (0.3x)');
        console.error('  mmodel        - MiniMax-M2.7 (0.2x)');
        process.exit(1);
    }
    
    args.message = argv.slice(messageStart).join(' ');
    return args;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    
    // Configure SDK with storage directory
    const storageDir = path.join(os.homedir(), '.qoder');
    configure({ storageDir });
    
    console.error(`[*] Querying model: ${args.model}`);
    console.error(`[*] Message: ${args.message.slice(0, 80)}${args.message.length > 80 ? '...' : ''}`);
    console.error('[*] Waiting for response...\n');
    
    const startTime = Date.now();
    let fullContent = '';
    let toolCalls = [];
    
    for await (const msg of query({ 
        prompt: args.message,
        options: { model: args.model }
    })) {
        switch (msg.type) {
            case 'system':
                console.error(`[*] Session ID: ${msg.session_id}`);
                if (msg.tools?.length) {
                    console.error(`[*] Tools available: ${msg.tools.length}`);
                }
                break;
                
            case 'stream_event':
                // Incremental text delta (for longer responses)
                if (msg.data?.delta?.content) {
                    process.stdout.write(msg.data.delta.content);
                    fullContent += msg.data.delta.content;
                }
                // Tool input delta
                if (msg.data?.delta?.tool_input) {
                    process.stdout.write(msg.data.delta.tool_input);
                }
                break;
                
            case 'assistant':
                // Full assistant message block
                if (msg.message?.content) {
                    for (const block of msg.message.content) {
                        if (block.type === 'text' && block.text) {
                            // Only print if we haven't been streaming
                            if (!fullContent) {
                                process.stdout.write(block.text);
                                fullContent += block.text;
                            }
                        } else if (block.type === 'tool_use') {
                            toolCalls.push(block);
                            console.error(`\n[*] Tool call: ${block.name}`);
                        }
                    }
                }
                break;
                
            case 'result':
                const duration = Date.now() - startTime;
                console.error(`\n\n[*] Response complete in ${duration}ms`);
                if (msg.duration_api_ms) {
                    console.error(`[*] API time: ${msg.duration_api_ms}ms`);
                }
                if (msg.num_input_tokens) {
                    console.error(`[*] Tokens: ${msg.num_input_tokens} input, ${msg.num_output_tokens || '?'} output`);
                }
                break;
        }
    }
    
    // Print full content to stderr for debugging
    if (fullContent) {
        console.error(`\n[*] Total response: ${fullContent.length} chars`);
    }
}

main().catch(e => {
    console.error(`\n[!] Error: ${e.message}`);
    if (e.message.includes('qoder login')) {
        console.error('\nPlease run: qoder login');
    }
    process.exit(1);
});
