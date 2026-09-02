import { Check } from 'lucide-react';
import {
  getStepStatus,
  type WorkflowStage,
} from '@forexplore/workflow-core';

const panelSteps: Array<{
  id: WorkflowStage;
  label: string;
  shortLabel: string;
}> = [
  { id: 'requirement', label: '定义任务', shortLabel: '01' },
  { id: 'candidates', label: '选择方案', shortLabel: '02' },
  { id: 'adaptation', label: '翻译 / 桥接', shortLabel: '03' },
  { id: 'patch', label: '校验与回填', shortLabel: '04' },
];

interface StepRailProps {
  stage: WorkflowStage;
  activeStep: WorkflowStage;
  onStepChange(step: WorkflowStage): void;
}

export function StepRail({ stage, activeStep, onStepChange }: StepRailProps) {
  return (
    <nav className="step-rail" aria-label="工作流进度">
      {panelSteps.map((step, index) => {
        const status = getStepStatus(step.id, stage);
        const navigable = status !== 'upcoming';
        return (
          <div
            className={`step is-${status}${activeStep === step.id ? ' is-current-view' : ''}`}
            key={step.id}
          >
            <button
              type="button"
              className="step-button"
              disabled={!navigable}
              aria-current={activeStep === step.id ? 'step' : undefined}
              aria-label={`${step.shortLabel} ${step.label}${navigable ? '' : '（尚未到达）'}`}
              title={navigable ? `查看：${step.label}` : '完成前序步骤后可查看'}
              onClick={() => onStepChange(step.id)}
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
