import { text, type StepType } from './types.js';

/**
 * Pauses the run until a human approves or rejects in the UI. The engine
 * handles the answer (see `resolveApproval` in engine/engine.ts): approval
 * continues with the next step, rejection either stops the run or jumps back
 * to the step chosen in "On reject, go back to".
 */
export const approvalStep: StepType = {
  type: 'approval',
  title: 'Wait for approval',
  description: 'Pauses until you approve or reject in the web UI. Use it for manual work such as deploying to staging, or as the final gate before a pull request.',
  fields: [
    { key: 'message', label: 'What you are asked to do', type: 'textarea', default: 'Please review the changes and approve to continue.' },
    {
      key: 'onReject',
      label: 'On reject, go back to',
      type: 'step',
      help: 'Optional. The run resumes at this earlier step and your comment is handed to Claude as feedback. Leave empty to stop the run on reject.',
    },
  ],
  async execute({ params }) {
    return { pause: { message: text(params, 'message', 'Approval required') } };
  },
};
