/** Builds the HTTP server: API, webhooks, web shell and the static web UI. */
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { getWorkflow } from '../store/workflows.js';
import { fireFor, getTriggerType } from '../triggers/index.js';
import { registerApi } from './api.js';
import { isAuthenticated, login, logout } from './auth.js';
import { registerShell } from './shell.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Request body exactly as received. Webhook signatures are computed over it. */
    rawBody?: string;
  }
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 5 * 1024 * 1024 });

  // Keep the raw text of JSON bodies, and accept YAML/plain text for formula imports.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = body as string;
    try {
      done(null, body === '' ? undefined : JSON.parse(body as string));
    } catch {
      done(new HttpError(400, 'The request body is not valid JSON'));
    }
  });
  app.addContentTypeParser(['application/yaml', 'text/yaml', 'text/plain'], { parseAs: 'string' }, (_request, body, done) => done(null, body));

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) console.error(error);
    reply.status(status).send({ error: error.message });
  });

  await app.register(fastifyWebsocket);

  // ---- Session ---------------------------------------------------------------
  app.post('/api/login', async (request, reply) => {
    login(String((request.body as any)?.token ?? ''), request, reply);
    return { ok: true };
  });
  app.post('/api/logout', async (_request, reply) => {
    logout(reply);
    return { ok: true };
  });
  app.get('/api/session', async (request) => ({ authenticated: isAuthenticated(request.headers) }));
  app.get('/healthz', async () => ({ ok: true }));

  // ---- Webhooks: authenticated by the trigger itself, not by the session ----
  app.post<{ Params: { id: string }; Querystring: Record<string, string> }>('/hooks/:id', async (request) => {
    const workflow = getWorkflow(request.params.id);
    const trigger = workflow && getTriggerType(workflow.definition.trigger.type);
    if (!workflow?.enabled || !trigger?.handleWebhook) throw new HttpError(404, 'No webhook here');
    await trigger.handleWebhook(
      workflow,
      { headers: request.headers, query: request.query, rawBody: request.rawBody ?? '', body: request.body },
      fireFor(workflow.id),
    );
    return { ok: true };
  });

  await app.register(registerApi, { prefix: '/api' });
  await app.register(registerShell);

  if (existsSync(config.webDir)) {
    await app.register(fastifyStatic, { root: config.webDir });
  }
  return app;
}
