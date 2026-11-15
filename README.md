# Auto Worker

A self-hosted, containerised application that lets Claude Code work on tasks
on its own, inside a sandbox, while you stay in control of the steps that
matter.

A typical workflow: a ClickUp task is assigned to you, Auto Worker picks it
up, notifies you, clones the repository and hands the task to Claude. Claude
implements it, the run pauses so you can deploy to staging, Claude tests, and
after your final approval the branch is pushed and a pull request is opened in
your name.

```mermaid
flowchart LR
    T([ClickUp task<br/>assigned to me]) --> N[Notify]
    N --> C[Clone repo]
    C --> I[Claude<br/>implements]
    I --> A1{{You: deploy<br/>to staging}}
    A1 --> V[Claude<br/>tests]
    V --> A2{{You: final<br/>approval}}
    A2 -- approve --> PR[Push and open PR<br/>as you]
    A2 -. reject with feedback .-> V
```

## What it does

- **Workflows as blocks.** Build them in the web UI or write them as YAML. Both are the same data.
- **Formulas.** Export a workflow with everything it needs (runtimes, MCP servers, Claude memory, environment variables, mounts, notification webhooks) and import it again after a redeploy.
- **Triggers.** ClickUp task assigned to you (poll or webhook), generic webhook, manual.
- **Human in the loop.** Approval blocks pause a run. Reject with a comment and Claude reworks it.
- **Full visibility.** Every run has a live log: trigger, Claude messages and tool calls, commands, test results, notifications, approvals.
- **A shell next to Claude.** Open a terminal in the run's workspace, as the same user Claude runs as.
- **Sandboxed.** Claude runs as an unprivileged user in a hardened container and only sees the secrets a workflow exposes to it.

## Documentation

| Document | Content |
|----------|---------|
| [docs/SPEC.md](docs/SPEC.md) | Requirements, concepts and milestones |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, run life cycle, data model, with diagrams |
| [docs/FORMULA.md](docs/FORMULA.md) | Formula reference: triggers, environment, notifications, blocks, templates |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Local setup, configuration, tests, adding blocks and triggers, API overview |

## Quick start (development)

```bash
npm install
AUTOWORKER_TOKEN=change-me npm run dev
```

The API listens on http://localhost:8080. See
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for details.

## Status

The project is built in milestones, see [docs/SPEC.md](docs/SPEC.md#milestones).
