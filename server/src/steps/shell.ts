import { blockCwd, cwdField, flag, text, type StepType } from './types.js';

const OUTPUT_TAIL = 20_000;

export const shellStep: StepType = {
  type: 'shell',
  title: 'Run command',
  description: 'Runs a shell command in the workspace as the agent user, e.g. installing dependencies or running tests.',
  fields: [
    { key: 'command', label: 'Command', type: 'textarea', placeholder: 'npm ci && npm test' },
    { key: 'continueOnError', label: 'Continue when the command fails', type: 'boolean', default: false },
    cwdField,
  ],
  async execute(runtime) {
    const { params, exec } = runtime;
    const command = text(params, 'command');
    if (!command) throw new Error('No command configured');
    const result = await exec('bash', ['-lc', command], { cwd: blockCwd(runtime) });
    const output = (result.stdout + result.stderr).slice(-OUTPUT_TAIL);
    if (result.code !== 0 && !flag(params, 'continueOnError')) {
      throw new Error(`Command failed with exit code ${result.code}`);
    }
    return { output: { exitCode: result.code, passed: result.code === 0, output } };
  },
};
