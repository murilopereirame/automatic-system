/**
 * Runs Claude Code headlessly (`claude -p`) in the workspace and turns its
 * stream-json output into run events.
 */
import { config } from '../config.js';
import { mcpConfigPath } from '../sandbox/environment.js';
import { OUTPUT_DIR_VARIABLE, runOutputDir } from '../sandbox/outputs.js';
import { renderString } from '../template.js';
import { blockCwd, cwdField, flag, text, type StepRuntime, type StepType } from './types.js';

interface ClaudeResult {
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
}

/** Translates one line of Claude's stream-json output into zero or more log entries. */
function logClaudeMessage(message: any, runtime: StepRuntime, cwd: string): void {
  if (message.session_id) {
    runtime.context.claudeSessionId = message.session_id;
    runtime.context.claudeSessionDir = cwd;
  }

  if (message.type === 'assistant') {
    for (const block of message.message?.content ?? []) {
      if (block.type === 'text' && block.text) runtime.log('claude_text', { text: block.text });
      if (block.type === 'tool_use') runtime.log('claude_tool', { tool: block.name, input: block.input });
    }
  } else if (message.type === 'user') {
    for (const block of message.message?.content ?? []) {
      if (block.type !== 'tool_result') continue;
      const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      runtime.log('claude_tool_result', { output: content.slice(0, 4000), isError: block.is_error === true });
    }
  }
}

function buildArgs(runtime: StepRuntime, prompt: string, cwd: string): string[] {
  const { params, context, workflow } = runtime;
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  args.push('--permission-mode', text(params, 'permissionMode', 'bypassPermissions'));
  if (text(params, 'model')) args.push('--model', text(params, 'model'));
  if (text(params, 'maxTurns')) args.push('--max-turns', text(params, 'maxTurns'));
  if (text(params, 'allowedTools')) args.push('--allowedTools', text(params, 'allowedTools'));
  if (flag(params, 'mentionOutputDir', true)) args.push('--append-system-prompt', outputDirInstructions(runtime.run.id));
  if (Object.keys(workflow.definition.environment.mcpServers).length > 0) {
    args.push('--mcp-config', mcpConfigPath(workflow.id));
  }
  if (flag(params, 'continueSession', true) && context.claudeSessionId) {
    // Sessions from before the folder was recorded were always in the default working directory.
    const sessionDir = context.claudeSessionDir ?? runtime.workdir;
    if (sessionDir === cwd) {
      args.push('--resume', context.claudeSessionId);
    } else {
      runtime.log('claude_new_session', { reason: 'The earlier conversation belongs to another folder, so this block starts a new one.' });
    }
  }
  return args;
}

/** Tells Claude where files meant for the user go, so they do not end up in the repository. */
export function outputDirInstructions(runId: string): string {
  return [
    `Files meant for the user rather than for the repository (screenshots, reports, logs, exported data, build artifacts) go in the output folder ${runOutputDir(runId)}, also available as the ${OUTPUT_DIR_VARIABLE} environment variable.`,
    'The user downloads them from the run page. The folder is outside the git repository, so nothing in it is committed.',
  ].join(' ');
}

/** Where the prompt of a Claude block came from. Logged with the prompt, so the run shows why it differs from the workflow. */
export type PromptSource = 'edited before run' | 'reviewer feedback' | 'edited for this run' | 'workflow';

/**
 * The prompt this start of the block sends, first match wins:
 *  1. the prompt a person confirmed when the run paused before this block (used once)
 *  2. the comment of a rejected approval that sent the run back here (used once)
 *  3. the prompt a person set for this block on the run page (a template, kept for the run)
 *  4. the prompt configured in the workflow
 * With `consume`, the one-time prompts (1 and 2) are removed from the run once read.
 * The preview of a paused block reads without consuming. See docs/PAUSE_BEFORE.md.
 */
export function resolvePrompt(runtime: Pick<StepRuntime, 'context' | 'params' | 'scope' | 'step'>, consume: boolean): { prompt: string; source: PromptSource } {
  const { context, params, scope, step } = runtime;
  const once = context.promptOnce?.[step.id];
  if (once !== undefined) {
    if (consume) {
      delete context.promptOnce![step.id];
      // The person saw the feedback prompt at the pause and replaced it, so the feedback is used up too.
      delete context.feedback;
    }
    return { prompt: once, source: 'edited before run' };
  }
  if (context.feedback) {
    const feedback = context.feedback;
    if (consume) delete context.feedback;
    return { prompt: `A human reviewed your work and asked for changes before continuing. Address this feedback:\n\n${feedback}`, source: 'reviewer feedback' };
  }
  const override = context.promptOverrides?.[step.id];
  if (override !== undefined) return { prompt: renderString(override, scope), source: 'edited for this run' };
  return { prompt: text(params, 'prompt'), source: 'workflow' };
}

export const claudeStep: StepType = {
  type: 'claude',
  title: 'Run Claude',
  description: 'Gives Claude Code a prompt and lets it work in the workspace. Its messages and tool calls are recorded on the run.',
  fields: [
    {
      key: 'prompt',
      label: 'Prompt',
      type: 'textarea',
      default: 'Implement the following task.\n\n{{trigger.task.name}}\n{{trigger.task.url}}\n\n{{trigger.task.description}}',
      help: 'Use {{trigger...}} and {{steps.<id>.output...}} to insert values from the run.',
    },
    { key: 'continueSession', label: 'Continue the conversation of earlier Claude steps', type: 'boolean', default: true },
    {
      key: 'mentionOutputDir',
      label: 'Tell Claude about the output folder',
      type: 'boolean',
      default: true,
      help: "Adds a note to Claude's system prompt: files meant for you (screenshots, reports, artifacts) go in the run's output folder, which you download from the run page.",
    },
    { key: 'model', label: 'Model', type: 'text', placeholder: 'Default model' },
    { key: 'permissionMode', label: 'Permission mode', type: 'select', options: ['bypassPermissions', 'acceptEdits', 'plan', 'default'], default: 'bypassPermissions' },
    { key: 'allowedTools', label: 'Allowed tools', type: 'text', placeholder: 'All tools', help: 'Comma separated, e.g. Read,Edit,Bash(npm test:*)' },
    { key: 'maxTurns', label: 'Maximum turns', type: 'number' },
    {
      ...cwdField,
      help: `${cwdField.help} Claude keeps one conversation per folder: to continue a conversation, run the Claude blocks in the same folder (with several repositories, use "." and tell Claude which folder to work in).`,
    },
  ],
  preview(runtime) {
    return resolvePrompt(runtime, false);
  },
  async execute(runtime) {
    const { prompt, source } = resolvePrompt(runtime, true);
    if (!prompt) throw new Error('No prompt configured');
    const cwd = blockCwd(runtime);
    runtime.log('claude_prompt', { prompt, source });

    let final: ClaudeResult | undefined;
    let pending = '';
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line);
        if (message.type === 'result') final = message;
        logClaudeMessage(message, runtime, cwd);
      } catch {
        runtime.log('output', { text: line });
      }
    };

    const result = await runtime.exec(config.claudeBin, buildArgs(runtime, prompt, cwd), {
      cwd,
      quiet: true,
      onOutput: (chunk, stream) => {
        if (stream === 'stderr') return runtime.log('output', { text: chunk, stream });
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        lines.forEach(handleLine);
      },
    });
    handleLine(pending);

    const outcome = final as ClaudeResult | undefined;
    if (result.code !== 0 || outcome?.is_error) {
      throw new Error(outcome?.result || `Claude exited with code ${result.code}: ${result.stderr.trim().slice(-1000)}`);
    }
    return {
      output: {
        result: outcome?.result ?? '',
        sessionId: runtime.context.claudeSessionId,
        costUsd: outcome?.total_cost_usd,
        turns: outcome?.num_turns,
      },
    };
  },
};
