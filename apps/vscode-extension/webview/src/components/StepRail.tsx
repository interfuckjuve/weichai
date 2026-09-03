import { Check } from 'lucide-react';
import type { WorkflowStageV2 } from '../v2-workflow';

type RailStage = 'requirement' | 'candidates' | 'adaptation' | 'patch';

const panelSteps: Array<{ id: RailStage; label: string; shortLabel: string }> = [
  { id: 'requirement', label: '定义任务', shortLabel: '01' },
  { id: 'candidates', label: '选择方案', shortLabel: '02' },
  { id: 'adaptation', label: '生成与验证', shortLabel: '03' },
  { id: 'patch', label: '校验与回填', shortLabel: '04' },
];

export function StepRail({
  stage,
  activeStep,
  onStepChange,
}: {
  stage: WorkflowStageV2;
  activeStep?: RailStage;
  onStepChange?(step: RailStage): void;
}) {
  const viewed = activeStep ?? (stage === 'complete' ? 'patch' : stage === 'target' ? 'requirement' : stage);
  return (
    <nav className="step-rail" aria-label="工作流进度">
      {panelSteps.map((step, index) => {
        const status = stepStatus(step.id, stage);
        const navigable = status !== 'upcoming' && Boolean(onStepChange);
        return (
          <div
            className={`step is-${status}${viewed === step.id ? ' is-current-view' : ''}`}
            key={step.id}
          >
            <button
              type="button"
              className="step-button"
              disabled={!navigable}
              aria-current={viewed === step.id ? 'step' : undefined}
              aria-label={`${step.shortLabel} ${step.label}`}
              title={navigable ? `查看：${step.label}` : status === 'upcoming' ? '完成前序步骤后可查看' : step.label}
              onClick={() => onStepChange?.(step.id)}
            >
              <span className="step-marker">
                {status === 'done' ? <Check size={11} strokeWidth={2.6} /> : step.shortLabel}
              </span>
              <span className="step-label">{step.label}</span>
            </button>
            {index < panelSteps.length - 1 ? <span className="step-line" /> : null}
          </div>
        );
      })}
    </nav>
  );
}

function stepStatus(step: RailStage, stage: WorkflowStageV2): 'done' | 'current' | 'upcoming' {
  const order: WorkflowStageV2[] = ['target', 'requirement', 'candidates', 'adaptation', 'patch', 'complete'];
  const currentIndex = order.indexOf(stage);
  const stepIndex = order.indexOf(step);
  if (stage === 'complete' || stepIndex < currentIndex) return 'done';
  if (stepIndex === currentIndex) return 'current';
  return 'upcoming';
}
