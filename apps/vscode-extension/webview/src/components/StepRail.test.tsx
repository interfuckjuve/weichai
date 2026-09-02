import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StepRail } from './StepRail';

describe('StepRail', () => {
  it('renders reached steps as buttons and disables future steps', () => {
    const markup = renderToStaticMarkup(
      <StepRail stage="candidates" activeStep="requirement" onStepChange={vi.fn()} />,
    );

    expect(markup).toContain('aria-current="step"');
    expect(markup.match(/<button/g)).toHaveLength(4);
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).toContain('查看：定义任务');
    expect(markup).not.toContain('描述需求');
    expect(markup).toContain('完成前序步骤后可查看');
  });

  it('treats the patch step as reachable after completion', () => {
    const markup = renderToStaticMarkup(
      <StepRail stage="complete" activeStep="patch" onStepChange={vi.fn()} />,
    );

    expect(markup).toContain('aria-label="04 校验与回填"');
    expect(markup).toContain('aria-current="step"');
    expect(markup).not.toContain('disabled=""');
  });
});
