/**
 * Web shell: a WebSocket connected to a bash process that runs as the agent
 * user, with the same environment and working directory Claude has. The user
 * can inspect the workspace or run git commands while a run is waiting.
 *
 * Protocol: the browser sends JSON `{type:"input",data}` and
 * `{type:"resize",cols,rows}`; the server sends raw terminal output.
 */
import type { FastifyInstance } from 'fastify';
import pty from 'node-pty';
import { config } from '../config.js';
import { agentShellCommand, baseEnv, workflowEnv } from '../sandbox/agent.js';
import { getRun } from '../store/runs.js';
import { getWorkflow } from '../store/workflows.js';
import { isAuthenticated, isSameOrigin } from './auth.js';

/** Where the shell starts and what it sees, depending on the run it was opened for. */
function shellSession(runId: string | undefined): { cwd: string; env: Record<string, string> } {
  const run = runId ? getRun(runId) : undefined;
  const workflow = run && getWorkflow(run.workflowId);
  if (!run || !workflow) return { cwd: config.agentHome, env: baseEnv() };
  return { cwd: run.context.workdir ?? run.workspace, env: workflowEnv({ ...workflow, definition: run.definition }) };
}

export async function registerShell(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { runId?: string } }>('/api/shell', { websocket: true }, (socket, request) => {
    if (!isAuthenticated(request.headers) || !isSameOrigin(request)) return socket.close(4401, 'Not signed in');

    const { cwd, env } = shellSession(request.query.runId);
    let terminal: pty.IPty;
    try {
      const { file, args } = agentShellCommand();
      terminal = pty.spawn(file, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env });
    } catch (error) {
      socket.send(`Could not start a shell in ${cwd}: ${(error as Error).message}\r\n`);
      return socket.close();
    }

    terminal.onData((data) => socket.send(data));
    terminal.onExit(() => socket.close());
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'input') terminal.write(String(message.data));
        if (message.type === 'resize') terminal.resize(Math.max(2, Number(message.cols)), Math.max(2, Number(message.rows)));
      } catch {
        // Ignore malformed messages.
      }
    });
    socket.on('close', () => terminal.kill());
  });
}
