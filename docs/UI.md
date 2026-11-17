# Web UI

The UI is a single-page React app in `web/`, served by the server. It talks to
the JSON API, receives live updates over server-sent events and opens the web
shell over a WebSocket.

## Pages

```mermaid
flowchart LR
    L[Sign in] --> W[Workflows]
    W -->|open or new| E[Workflow editor]
    W -->|import formula| E
    E -->|Run now| R[Run]
    RS[Runs] --> R
    I[Inbox] -->|open run| R
    S[Settings]
```

| Page | What you do there |
|------|-------------------|
| **Workflows** | See all workflows, import a formula file, start a run |
| **Workflow editor** | Build the workflow. Four tabs, all editing the same formula |
| **Runs** | History of runs with their state and current block |
| **Run** | Follow a run live, answer its approvals, open a shell, cancel, retry or skip a block |
| **Inbox** | Every approval that is waiting for you, across all runs. The number in the navigation is the count |
| **Settings** | Secrets and the commit author (used for every commit in a run, including the ones Claude makes) |

## Workflow editor

![Block editor](images/editor.png)

- **Blocks**: the **Run now** block and the triggers on top, then the blocks in
  the order they run. Open the **Run now** block to add inputs: values a manual
  run asks for, see [Run now with inputs](#run-now-with-inputs). Any
  trigger starts a run. **+ Add trigger** adds one, also a second of the same
  type; click a trigger to edit its settings. Triggers that are called from
  outside show their own URL. Without triggers, runs start only from **Run now**.
  Use the `+` between blocks to insert one, drag a block or use the arrows to
  reorder, click a block to edit its settings. Every block has a **Run only
  if** setting, and the **Condition** block branches to another block; both
  show their expression on the block. See [EXPRESSIONS.md](EXPRESSIONS.md).
- **Environment**: runtimes, environment variables, which secrets Claude may
  see, Claude memory files, MCP servers and expected volume mounts.
- **Notifications**: the webhook calls, with templated URL, headers and body.
- **Code**: the formula YAML. Edit and press **Apply to blocks**, and the
  blocks update. This is the same text **Export formula** downloads.

![Environment tab](images/environment.png)

### Applying a save to open runs

When you save a workflow that has open runs (running, waiting, failed or
cancelled) on the previous version, the editor offers **Apply to them**. It
switches all of them to what you just saved, with the same rules as on the run
page. **Keep as they are** leaves them alone; you can still apply the edits to
one run from its page later.

![The editor offers to apply a save to open runs](images/apply-latest-editor.png)

## Run now with inputs

![Run now form](images/run-now-inputs.png)

**Run now**, on the workflow list and in the editor, starts a workflow by
hand. When the workflow declares inputs, a form asks for them first. Fields
marked `*` are required. **Trigger payload** shows the JSON the run will start
with, which is what blocks read as `{{trigger...}}`. The run page lists the
same payload under **Triggered**. Inputs are described in
[FORMULA.md](FORMULA.md#inputs-of-a-manual-run).

## Run page

![Run page with an approval and the shell](images/run-with-shell.png)

- The list on the left shows every block and its state. Click one to see only its activity.
  Blocks a condition passed over are marked **Skipped**, and a condition block shows what it decided.
- The activity log updates live: prompts, Claude's messages, tool calls, commands and their output, notifications, approvals.
- A pending approval appears on top. Approve to continue. Reject with a
  comment to send the run back to an earlier block with your comment as
  feedback for Claude, when the block is configured that way.
- **Skip "block name"** passes over the block the run is at and continues with
  the next one. Use it when a block is stuck or not needed this time. It is
  there while the block runs (what it is doing is stopped), waits for you, or
  has failed. The block is marked **Skipped** and has no output.
- **This workflow was edited after this run started** appears when the
  workflow was saved with changes after the run took its copy, and the run
  has not succeeded. **Review changes** lists each block that differs and
  whether this run will notice: finished blocks keep their results, the block
  the run is at and the ones after it use the new settings. **Apply latest
  workflow** switches the run. A block that is running right now finishes as
  it is first; a failed run picks the changes up when you retry it.

  ![Applying the latest workflow to a waiting run](images/apply-latest-run.png)
- **Retry from failed block** runs the failed block again. A condition block
  that had gone back too often gets its full number of repeats again.
- **Open shell** starts a terminal in the run's workspace, as the same user
  and with the same environment as Claude. Use it to inspect the work or run
  git commands while the run waits for you.

## Code structure

| Path | Responsibility |
|------|----------------|
| `web/src/api.ts` | Typed API client. Domain types are imported from `server/src/types.ts` |
| `web/src/live.ts` | One shared server-sent-events connection, `useLive` hook |
| `web/src/router.ts` | Hash router |
| `web/src/App.tsx` | Sign-in gate, navigation, page routing |
| `web/src/pages/` | One file per page |
| `web/src/components/BlockPipeline.tsx` | The block editor |
| `web/src/components/FieldInput.tsx` | Renders one setting from its field description |
| `web/src/components/EventLog.tsx` | Renders run events by type |
| `web/src/components/Terminal.tsx` | xterm.js terminal for the web shell |
| `web/src/components/ApplyLatestCard.tsx` | Run page card that previews and applies workflow edits to the run |

The forms of blocks and triggers are generated from the catalogue the server
returns at `GET /api/meta`. Adding a block type on the server needs no UI
change. To give a new event type its own look in the run log, add a case to
`describe` in `EventLog.tsx`.

## Development

```bash
npm run dev        # server on :8080
npm run dev:web    # UI on :5173 with hot reload, proxies /api to the server
```

`npm run build` builds the UI into `web/dist`, which the server serves.
