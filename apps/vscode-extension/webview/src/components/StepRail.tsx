import { Check } from 'lucide-react';
import {
  getStepStatus,
  workflowSteps,
  type WorkflowStage,
} from '@forexplore/workflow-core';

export function StepRail({ stage }: { stage: WorkflowStage }) {
  return (
    <nav className="step-rail" aria-label="工作流进度">
      {workflowSteps.map((step, index) => {
        const status = getStepStatus(step.id, stage);
        return (
          <div className={`step is-${status}`} key={step.id}>
            <span className="step-marker">
              {status === 'done' ? <Check size={11} strokeWidth={2.6} /> : step.shortLabel}
            </span>
            <span className="step-label">
              {step.id === 'adaptation' ? '生成与适配' : step.label}
            </span>
            {index < workflowSteps.length - 1 ? <span className="step-line" /> : null}
          </div>
        );
      })}
    </nav>
  );
}
