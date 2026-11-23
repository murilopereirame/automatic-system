# Development

## Setup

Requirements: Node.js 22.13 or newer, git, and a C++ toolchain for the
terminal library (`node-pty`).

```bash
npm install
npm run dev          # API on http://localhost:8080, restarts on change
npm run dev:web      # web UI on http://localhost:5173 with hot reload
npm test             # run the test suite
npm run typecheck
```

On first start without `AUTOWORKER_TOKEN`, the server prints a generated login
token. Data goes to `./data`.

Outside the container there is no separate agent user: Claude and commands run
as your own user, with a clean environment and `./data/agent-home` as home.
Use the container for anything you do not fully trust.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `AUTOWORKER_TOKEN` | generated | Login token for the UI and API |
| `AUTOWORKER_SECRET_KEY` | the token | Passphrase that encrypts stored secrets |
| `AUTOWORKER_PUBLIC_URL` | empty | Base URL used for links in notifications |
| `AUTOWORKER_PORT`, `AUTOWORKER_HOST` | `8080`, `0.0.0.0` | Listen address |
| `AUTOWORKER_DATA_DIR` | `./data` | Database directory |
| `AUTOWORKER_WORKSPACES_DIR` | `<data>/workspaces` | Run workspaces |
| `AUTOWORKER_OUTPUTS_DIR` | `<data>/outputs` | Output folders of runs, one per run ([OUTPUTS.md](OUTPUTS.md)) |
| `AUTOWORKER_AGENT_HOME` | `<data>/agent-home` | Home of the agent user |
| `AUTOWORKER_AGENT_UID`, `AUTOWORKER_AGENT_GID` | unset | Run agent processes as this user |
| `AUTOWORKER_FORMULAS_DIR` | unset | Formula files imported at startup |
| `AUTOWORKER_CLAUDE_BIN` | `claude` | Claude Code executable |

## Tests

Tests live in `server/test` (and, for UI logic without React, `web/test`) and use the Node.js test runner. Nothing talks to
the internet:

- `fixtures/fake-claude.mjs` stands in for the Claude CLI and speaks the same stream-json protocol.
- `mockApi` in `helpers.ts` starts local HTTP servers for ClickUp, GitHub and notification receivers.
- A local bare git repository stands in for GitHub when testing clone and push.

Each test file runs in its own process with its own temporary data directory.

## Adding a block

1. Create `server/src/steps/my-block.ts`:

   ```ts
   import { text, type StepType } from './types.js';

   export const myBlock: StepType = {
     type: 'my_block',
     title: 'My block',
     description: 'Shown in the block palette.',
     fields: [{ key: 'target', label: 'Target', type: 'text' }],
     async execute({ params, exec, log }) {
       const result = await exec('echo', [text(params, 'target')]);
       return { output: { exitCode: result.code } };
     },
   };
   ```

2. Add it to the list in `server/src/steps/index.ts`.
3. Add a test, and a row to the block table in [FORMULA.md](FORMULA.md).

The UI needs no change: it renders the form from `fields`.

Rules of thumb for blocks:

- Run anything that touches the workspace through `runtime.exec`, so it runs as the agent user and is logged.
- Read tokens with `requireSecret` inside the block. Do not put them in `fields` defaults or log them.
- Throw an `Error` with a message a user can act on. The engine turns it into a failed run.

## Adding a trigger

1. Create `server/src/triggers/my-trigger.ts` implementing `TriggerType`:
   `start` for triggers that watch something, `handleWebhook` for triggers
   that are called. Both receive the `trigger` they are about (its id and
   settings), because a workflow can hold several triggers of one type.
2. Call `fire(payload, dedupeKey)` to start a run. With a `dedupeKey`, the same item starts a run only once per workflow.
3. Add it to the list in `server/src/triggers/index.ts`.

## API overview

All routes under `/api` need the session cookie or `Authorization: Bearer <token>`.

| Route | Purpose |
|-------|---------|
| `POST /api/login`, `POST /api/logout`, `GET /api/session` | Session |
| `GET /api/meta` | Catalogue of block and trigger types with their fields |
| `GET/POST /api/workflows`, `GET/PUT/DELETE /api/workflows/:id` | Workflows |
| `POST /api/workflows/:id/run` | Start a run manually. The JSON body is the trigger payload, checked against the workflow's `inputs` |
| `GET /api/workflows/:id/formula` | Export as formula. `?history=true` adds the earlier versions |
| `GET /api/workflows/:id/versions`, `.../versions/:n`, `.../versions/:n/diff`, `POST .../versions/:n/restore` | Version history, diff and rollback. See [VERSIONING.md](VERSIONING.md#api) |
| `POST /api/formulas/import` | Import a formula (YAML body) |
| `GET /api/runs`, `GET /api/runs/:id` | Runs; one run with its approvals |
| `GET /api/runs/:id/events` | The run's log, newest page first: `{ events, hasOlder }`. `?before=<event id>` pages back, `?stepId=` keeps one block, `?limit=` (default 300, max 1000) |
| `GET /api/runs/:id/outputs`, `GET /api/runs/:id/outputs/file?path=`, `GET /api/runs/:id/outputs/archive` | Files in the run's output folder; one file, or all as `.tar.gz` ([OUTPUTS.md](OUTPUTS.md)) |
| `POST /api/runs/:id/cancel`, `POST /api/runs/:id/retry`, `POST /api/runs/:id/skip` | Control a run: stop it, continue from the block it stopped at, or pass over that block |
| `PUT /api/runs/:id/vars/:name`, `DELETE /api/runs/:id/vars/:name` | Add (body `{ "value": ... }`) or remove a value later blocks read as `{{vars.<name>}}`. Answers with all values of the run. See [RUN-VALUES.md](RUN-VALUES.md) |
| `POST /api/runs/:id/cleanup`, `POST /api/runs/cleanup` | Delete the files of one ended run, or of every ended run ([CLEANUP.md](CLEANUP.md)) |
| `GET /api/runs/:id/apply-latest`, `POST /api/runs/:id/apply-latest` | Preview, or apply, switching a run to the saved workflow. `GET /api/runs/:id` says `outdated: true` when there is something to apply |
| `GET /api/workflows/:id/outdated-runs`, `POST /api/workflows/:id/apply-to-runs` | Open runs still on an older definition, and applying the saved one to all of them |
| `GET /api/stream` | Server-sent events with live run updates |
| `GET /api/approvals?status=pending`, `POST /api/approvals/:id/resolve` | Inbox |
| `GET /api/secrets`, `PUT/DELETE /api/secrets/:name` | Secrets (names only on read) |
| `GET/PUT /api/settings` | Commit author of everything a run commits |
| `WS /api/shell?runId=` | Web shell |
| `POST /hooks/:workflowId/:triggerId` | Webhook triggers (authenticated by the trigger). Without `:triggerId` it calls the first trigger that takes webhooks |
