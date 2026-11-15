/**
 * Test setup. Import this file first: it points the app at a throwaway data
 * directory and at the fake Claude CLI before any app module reads its config.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const tempDir = mkdtempSync(path.join(tmpdir(), 'autoworker-test-'));
export const TOKEN = 'test-token';

process.env.AUTOWORKER_DATA_DIR = path.join(tempDir, 'data');
process.env.AUTOWORKER_TOKEN = TOKEN;
process.env.AUTOWORKER_CLAUDE_BIN = path.join(import.meta.dirname, 'fixtures/fake-claude.mjs');
delete process.env.AUTOWORKER_AGENT_UID;

export interface MockRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: any;
}

/** Starts a local HTTP server standing in for an external API. Returns its base URL and the requests it received. */
export async function mockApi(handler: (request: MockRequest) => unknown): Promise<{ url: string; requests: MockRequest[]; close: () => void }> {
  const requests: MockRequest[] = [];
  const server = createServer(async (incoming, response) => {
    let raw = '';
    for await (const chunk of incoming) raw += chunk;
    const request = { method: incoming.method!, url: incoming.url!, headers: incoming.headers, body: raw ? JSON.parse(raw) : undefined };
    requests.push(request);
    const result = handler(request);
    response.writeHead(result === undefined ? 404 : 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result ?? { message: 'not mocked' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}

/** Polls until `check` returns something truthy. */
export async function waitFor<T>(check: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
