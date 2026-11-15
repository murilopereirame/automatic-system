/** Registry of all block types. The UI builds its block palette and forms from this list. */
import { approvalStep } from './approval.js';
import { claudeStep } from './claude.js';
import { conditionStep } from './condition.js';
import { clickupCommentStep, clickupFetchTaskStep } from './clickup.js';
import { gitCloneStep } from './git-clone.js';
import { githubPrStep } from './github-pr.js';
import { notifyStep } from './notify.js';
import { shellStep } from './shell.js';
import type { StepType } from './types.js';

export const stepTypes: StepType[] = [
  notifyStep,
  clickupFetchTaskStep,
  gitCloneStep,
  claudeStep,
  shellStep,
  approvalStep,
  conditionStep,
  githubPrStep,
  clickupCommentStep,
];

export function getStepType(type: string): StepType | undefined {
  return stepTypes.find((candidate) => candidate.type === type);
}
