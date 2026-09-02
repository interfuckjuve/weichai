import { Check } from 'lucide-react';
import type { WorkflowStageV2 } from '../v2-workflow';

const workflowSteps = [
  { id: 'requirement', label: '目标与需求', shortLabel: '1' },
  { id: 'candidates', label: '候选与来源 bundle', shortLabel: '2' },
  { id: 'adaptation', label: 'V2 生成与验证', shortLabel: '3' },
  { id: 'patch', label: '补丁与回填', shortLabel: '4' },
] as const;

export function StepRail({ stage }: { stage: WorkflowStageV2 }) {
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
              {step.label}
            </span>
            {index < workflowSteps.length - 1 ? <span className="step-line" /> : null}
          </div>
        );
      })}
    </nav>
  );
}

function getStepStatus(
  step: typeof workflowSteps[number]['id'],
  stage: WorkflowStageV2,
): 'pending' | 'active' | 'done' {
  const order: WorkflowStageV2[] = ['requirement', 'candidates', 'adaptation', 'patch', 'complete'];
  const stepIndex = order.indexOf(step);
  const stageIndex = order.indexOf(stage);
  if (stageIndex < 0) return 'pending';
  if (stage === 'complete' || stepIndex < stageIndex) return 'done';
  return stepIndex === stageIndex ? 'active' : 'pending';
}
