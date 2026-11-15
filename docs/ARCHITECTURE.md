# Architecture

One Node.js process serves the web UI and the API, watches triggers and runs
workflows. Claude Code, workflow commands and the web shell are child
processes that run as a separate, unprivileged user.

## Components

```mermaid
flowchart TB
    subgraph Browser
        UI[Web UI<br/>block editor, runs, inbox, terminal]
    end

    subgraph Container
        subgraph Server["Server process (Node.js)"]
            HTTP[HTTP layer<br/>http/]
            TRG[Trigger manager<br/>triggers/]
            ENG[Engine<br/>engine/]
            STEPS[Block types<br/>steps/]
            STORE[(SQLite<br/>store/)]
            SBX[Sandbox helpers<br/>sandbox/]
        end
        subgraph Agent["Agent user (no privileges)"]
            CLAUDE[Claude Code]
            CMD[Commands and tests]
            SH[Web shell]
        end
        WS[/workspaces/]
        HOME[/agent home: memory, runtimes/]
    end

    EXT[ClickUp, GitHub,<br/>notification webhooks]

    UI <-->|REST, SSE, WebSocket| HTTP
    EXT -->|webhooks| HTTP
    TRG -->|poll| EXT
    HTTP --> ENG
    TRG --> ENG
    ENG --> STEPS
    ENG <--> STORE
    STEPS --> SBX
    STEPS -->|API calls| EXT
    SBX -->|spawn as agent| Agent
    Agent --- WS
    Agent --- HOME
```

## Source layout

| Path | Responsibility |
|------|----------------|
| `server/src/main.ts` | Startup: recover runs, import formula files, start triggers, listen |
| `server/src/config.ts` | The only place that reads environment variables |
| `server/src/types.ts` | Domain types shared by every module |
| `server/src/db.ts`, `store/` | SQLite schema and one small module per table group |
| `server/src/formula.ts` | Validation of workflow definitions, YAML import and export |
| `server/src/template.ts` | `{{ value }}` templating |
| `server/src/engine/engine.ts` | The run state machine |
| `server/src/steps/` | One file per block type, registered in `steps/index.ts` |
| `server/src/triggers/` | One file per trigger type, plus the manager in `triggers/index.ts` |
| `server/src/sandbox/` | Running processes as the agent user, preparing runtimes, memory and MCP config |
| `server/src/notify.ts` | Notification webhooks |
| `server/src/egress.ts` | The egress allow list (what is on it, what was blocked) |
| `server/src/gateway/` | The gateway container: UI relay and allow-list proxy. Shares no state with the server |
| `server/src/http/` | Server setup, authentication, JSON API, web shell |
| `server/test/` | Tests. External services are replaced by local stand-ins |
| `web/src/` | The React web UI, see [UI.md](UI.md) |

Block types and trigger types describe their own settings (`fields`). The UI
asks the API for this catalogue (`GET /api/meta`) and renders the forms from
it, so a new block needs no UI change.

## Life of a run

```mermaid
stateDiagram-v2
    [*] --> queued: any trigger fires
    queued --> running
    running --> waiting: approval block
    waiting --> running: approved (next block)
    waiting --> running: rejected (go back with feedback)
    waiting --> cancelled: rejected (no go-back block)
    running --> succeeded: last block done
    running --> failed: a block throws
    running --> cancelled: user cancels
    failed --> running: retry
    cancelled --> running: retry
    succeeded --> [*]
```

A workflow can have several triggers. The trigger manager keeps one watcher
per trigger and every trigger has its own webhook URL. Whichever fires first
starts the run, and the run records it as `triggeredBy`.

```mermaid
flowchart LR
    subgraph Workflow
        T1[Trigger: clickup<br/>poll watcher]
        T2[Trigger: webhook<br/>/hooks/workflow/webhook]
    end
    T1 -- fire --> D{Seen this item<br/>before?}
    T2 -- fire --> D
    N[Run now] --> S
    D -- no --> S[startRun<br/>triggeredBy = id and type]
    D -- yes --> X[ignored]
```

`run.stepIndex` always points at the block that is running, waiting or that
failed. Resuming after an approval and retrying after a failure are therefore
the same operation: continue from `stepIndex`.

A run keeps a copy of the workflow definition it started with, so editing a
workflow never changes runs that are in flight.

If the server restarts, runs that were executing are marked as failed with a
note, and can be retried from the block they were in. Runs waiting for
approval simply keep waiting.

## How a block executes

```mermaid
sequenceDiagram
    participant E as Engine
    participant S as Block type
    participant X as sandbox/agent.ts
    participant P as Process (agent user)
    participant DB as Event log

    E->>E: render {{templates}} in the block settings
    E->>DB: step_started
    E->>S: execute(runtime)
    S->>X: runtime.exec(command)
    X->>P: spawn with clean environment, agent uid
    P-->>DB: output events (live to the UI)
    P-->>S: exit code, output
    S-->>E: { output } or { pause }
    E->>DB: step_finished / approval_requested
```

What a block returns decides what happens next:

- `{ output }`: stored as `steps.<id>.output` for later templates, then the next block runs.
- `{ pause: { message } }`: an approval is created and the run waits.
- throwing an error: the run fails at this block.

## Data model

```mermaid
erDiagram
    WORKFLOW ||--o{ RUN : "starts"
    RUN ||--o{ EVENT : "logs"
    RUN ||--o{ APPROVAL : "asks"
    WORKFLOW ||--o{ TRIGGER_SEEN : "deduplicates"
    WORKFLOW {
        text id
        text name
        bool enabled
        text hook_secret
        json definition
    }
    RUN {
        text id
        text status
        int step_index
        json definition
        json context
        text workspace
    }
    EVENT {
        int id
        text step_id
        text type
        json data
    }
    APPROVAL {
        text id
        text step_id
        text message
        text status
        text comment
    }
    SECRET {
        text name
        text value_encrypted
    }
```

## Where things live on disk

| Location (container) | Owner | Content |
|----------------------|-------|---------|
| `/data` | server | Database with workflows, runs and encrypted secrets. The agent user cannot read it |
| `/workspaces/<run id>` | agent | Working directory of a run, including the cloned repository |
| `/home/agent/workflows/<workflow id>/claude` | agent | Claude config directory of a workflow: `CLAUDE.md`, memory, sessions |
| `/home/agent/workflows/<workflow id>/mcp.json` | agent | MCP servers from the formula |
| `/home/agent/.local/share/mise` | agent | Installed language runtimes |

## Secrets and who sees them

```mermaid
flowchart LR
    S[(Secret store<br/>AES-256-GCM)]
    S -->|"listed in environment.secrets"| A[Claude, commands, web shell]
    S -->|"token of a block (ClickUp, GitHub)"| B[Server-side API call<br/>or one git process]
    S -->|"{{secrets.NAME}} in a notification"| N[Webhook request]
    S -.->|never| F[Formula export]
    S -.->|never| API[API responses]
```

Claude only receives the secrets a workflow lists under
`environment.secrets`. The GitHub token used for pushing is not in that list
in the example workflow, so Claude can commit but cannot push. Pushing happens
in the pull request block, after the approval block before it.
