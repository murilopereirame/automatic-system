/**
 * Runs Claude Code headlessly (`claude -p`) in the workspace and turns its
 * stream-json output into run events.
 */
import { config } from '../config.js';
import { mcpConfigPath } from '../sandbox/environment.js';
import { OUTPUT_DIR_VARIABLE, runOutputDir } from '../sandbox/outputs.js';
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

/** A rejected approval hands its comment to the next Claude step, once. */
function promptFor(runtime: StepRuntime): string {
  const { context, params } = runtime;
  if (!context.feedback) return text(params, 'prompt');
  const feedback = context.feedback;
  delete context.feedback;
  return `A human reviewed your work and asked for changes before continuing. Address this feedback:\n\n${feedback}`;
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
  async execute(runtime) {
    const prompt = promptFor(runtime);
    if (!prompt) throw new Error('No prompt configured');
    const cwd = blockCwd(runtime);
    runtime.log('claude_prompt', { prompt });

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
