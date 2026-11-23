#!/usr/bin/env node
/**
 * Stand-in for the `claude` CLI in tests. Speaks the same stream-json
 * protocol: it "works" by appending the prompt to claude-output.txt in the
 * current directory and reports whether it was asked to resume a session.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1];
const resumed = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const sessionId = resumed ?? 'session-1';
const emit = (message) => console.log(JSON.stringify(message));

if (prompt.includes('FAIL')) {
  emit({ type: 'result', subtype: 'error', is_error: true, result: 'Claude could not do it', session_id: sessionId });
  process.exit(1);
}

appendFileSync('claude-output.txt', `${prompt}\n`);
// Like a real Claude following its system prompt: notes for the user go in the output folder.
const systemNote = args.includes('--append-system-prompt') ? args[args.indexOf('--append-system-prompt') + 1] : null;
if (systemNote && process.env.AUTOWORKER_OUTPUT_DIR) writeFileSync(path.join(process.env.AUTOWORKER_OUTPUT_DIR, 'claude-notes.md'), `${systemNote}\n`);
emit({ type: 'system', subtype: 'init', session_id: sessionId });
emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: `Working on: ${prompt}` }] } });
emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'claude-output.txt' } }] } });
emit({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', content: 'File written' }] } });
emit({ type: 'result', subtype: 'success', is_error: false, result: `Done${resumed ? ' (resumed)' : ''}`, total_cost_usd: 0.01, num_turns: 2, session_id: sessionId });
