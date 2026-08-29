import { useMemo, useReducer } from 'react';
import {
  Blocks,
  Boxes,
  Braces,
  CodeXml,
  Database,
  FileSearch,
  GitCompareArrows,
  PanelLeftClose,
  Play,
  Search,
  Settings2,
  Sparkles,
  Workflow,
} from 'lucide-react';
import type {
  AdaptationStrategy,
  ModuleNode,
} from '@forexplore/contracts';
import {
  initialWorkflowState,
  selectedCandidate,
  type WorkflowPorts,
  workflowReducer,
} from '@forexplore/workflow-core';
import { CandidateBrowser } from './features/candidate-selection/CandidateBrowser';
import { PatchReview } from './features/patch-review/PatchReview';
import { ModuleTree } from './features/target-selection/ModuleTree';
import { WorkflowRail } from './features/workflow-progress/WorkflowRail';

const strategyOptions: Array<{
  id: AdaptationStrategy;
  label: string;
  detail: string;
}> = [
  { id: 'translate', label: '翻译实现', detail: '转换到目标语言并保持行为' },
  { id: 'bridge', label: '运行时桥接', detail: '保留源实现，通过协议调用' },
  { id: 'wrap', label: '适配器封装', detail: '添加目标接口与数据转换层' },
  { id: 'reuse', label: '同语言复用', detail: '最小修改直接嵌入' },
];

function RequirementPanel({
  state,
  dispatch,
  onSearch,
  searchProvider,
}: {
  state: typeof initialWorkflowState;
  dispatch: React.Dispatch<Parameters<typeof workflowReducer>[1]>;
  onSearch: () => void;
  searchProvider: string;
}) {
  const canSearch = Boolean(state.target);

  return (
    <div className="requirement-layout">
      <section className="requirement-main">
        <div className="section-intro">
          <div className="eyebrow">目标模块已锁定</div>
          <h1>描述这个模块需要补齐的能力</h1>
          <p>
            检索接口同时接收自然语言需求和目标符号契约；真实检索器可替换当前 Mock
            Adapter。
          </p>
        </div>

        <label className="field-label" htmlFor="requirement">
          功能需求（可选）
        </label>
        <textarea
          id="requirement"
          className="requirement-textarea"
          value={state.requirement}
          onChange={(event) => dispatch({ type: 'SET_REQUIREMENT', value: event.target.value })}
          placeholder="例如：为报价读取增加 5 秒 TTL 缓存、并发请求合并、800ms 超时与失败时 stale 回退；保持现有 QuoteRequest → Task<Quote> 接口不变。"
        />
        <div className="field-hint">
          <span>{state.requirement.trim().length} 字符</span>
          <span>留空时使用目标名称、签名和源码注释检索。</span>
        </div>

        <div className="query-preview">
          <div className="panel-caption">检索请求预览</div>
          <dl>
            <div>
              <dt>symbol</dt>
              <dd>{state.target?.signature}</dd>
            </div>
            <div>
              <dt>scope</dt>
              <dd>server://authorized-repositories</dd>
            </div>
            <div>
              <dt>language</dt>
              <dd>{state.target?.language}</dd>
            </div>
          </dl>
        </div>
      </section>

      <aside className="search-config">
        <section>
          <h3>混合检索</h3>
        </section>

        <section>
          <label className="range-heading" htmlFor="top-k">
            <span>返回方案数</span>
            <strong>Top {state.topK}</strong>
          </label>
          <input
            id="top-k"
            type="range"
            min="2"
            max="5"
            value={state.topK}
            onChange={(event) =>
              dispatch({ type: 'SET_TOP_K', value: Number(event.target.value) })
            }
          />
          <div className="range-scale">
            <span>2</span>
            <span>5</span>
          </div>
        </section>

        <section className="repository-scope">
          <h3>代码仓范围</h3>
          <label>
            <input type="checkbox" defaultChecked disabled /> 服务端授权仓库
            <span>由检索服务 allow-list 决定</span>
          </label>
          <label>
            <input type="checkbox" defaultChecked disabled /> 当前检索语料
            <span>{searchProvider === 'SeekDB' ? 'SeekDB code corpus' : 'Mock catalog'}</span>
          </label>
        </section>

        <button
          type="button"
          className="button-primary search-action"
          disabled={!canSearch || state.pending === 'search'}
          onClick={onSearch}
        >
          {state.pending === 'search' ? (
            <span className="loading-dot" />
          ) : (
            <Search size={15} />
          )}
          {state.pending === 'search' ? '正在调用检索接口…' : '检索相似实现'}
        </button>
      </aside>
    </div>
  );
}

function SelectionFooter({
  state,
  dispatch,
  onAdapt,
  adaptationProvider,
}: {
  state: typeof initialWorkflowState;
  dispatch: React.Dispatch<Parameters<typeof workflowReducer>[1]>;
  onAdapt: () => void;
  adaptationProvider: string;
}) {
  const candidate = selectedCandidate(state);
  if (!candidate) return null;
  const realAdaptation = adaptationProvider !== 'Mock';

  return (
    <div className="selection-workbench">
      <div className="decision-fields">
        <label>
          <span>适配方式</span>
          <select
            value={state.strategy}
            onChange={(event) =>
              dispatch({
                type: 'SET_STRATEGY',
                value: event.target.value as AdaptationStrategy,
              })
            }
          >
            {strategyOptions.map((option) => (
              <option
                key={option.id}
                value={option.id}
                disabled={realAdaptation && option.id !== 'translate'}
              >
                {option.label} · {option.detail}
                {realAdaptation && option.id !== 'translate' ? '（演示服务暂不支持）' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="decision-notes">
          <span>人工备注 / 额外约束</span>
          <input
            type="text"
            value={state.decisionNotes}
            onChange={(event) =>
              dispatch({ type: 'SET_DECISION_NOTES', value: event.target.value })
            }
            placeholder="例如：缓存必须通过构造函数注入；禁止新增全局状态。"
          />
        </label>
      </div>
      <button
        type="button"
        className="button-primary"
        onClick={onAdapt}
      >
        <Sparkles size={15} /> 使用此方案并生成适配
      </button>
    </div>
  );
}

function Inspector({
  state,
  searchProvider,
  adaptationProvider,
}: {
  state: typeof initialWorkflowState;
  searchProvider: string;
  adaptationProvider: string;
}) {
  const candidate = selectedCandidate(state);
  return (
    <aside className="inspector-pane">
      <div className="pane-heading">
        <span>上下文</span>
        <Settings2 size={14} />
      </div>

      <section className="inspector-section">
        <h3>目标符号</h3>
        {state.target ? (
          <div className="target-card">
            <div className="target-kind">
              {state.target.kind === 'class' ? <Boxes size={15} /> : <Braces size={15} />}
              {state.target.kind}
              {state.target.implementationStatus === 'unimplemented' ? (
                <span className="implementation-status">待实现</span>
              ) : null}
            </div>
            <strong>{state.target.name}</strong>
            <code>{state.target.signature}</code>
            {state.target.documentation ? (
              <p className="target-documentation">
                <span>源码注释</span>
                {state.target.documentation}
              </p>
            ) : null}
            <span>
              {state.target.path}:{state.target.line}
            </span>
          </div>
        ) : (
          <p className="empty-copy">从左侧模块树选择 class 或 function。</p>
        )}
      </section>

      <section className="inspector-section">
        <h3>工作流端口</h3>
        <div className="port-list">
          <div>
            <FileSearch size={14} />
            <span>
              <strong>CodeSearchPort</strong>
              <small>{searchProvider} · Top-K</small>
            </span>
            <em>ready</em>
          </div>
          <div>
            <GitCompareArrows size={14} />
            <span>
              <strong>CodeAdaptationPort</strong>
              <small>{adaptationProvider} · Java → C#</small>
            </span>
            <em>ready</em>
          </div>
          <div>
            <CodeXml size={14} />
            <span>
              <strong>CodeBackfillPort</strong>
              <small>Mock · workspace edit</small>
            </span>
            <em>ready</em>
          </div>
        </div>
      </section>

      {candidate ? (
        <section className="inspector-section">
          <h3>当前决策</h3>
          <dl className="decision-summary">
            <div>
              <dt>方案</dt>
              <dd>{candidate.title}</dd>
            </div>
            <div>
              <dt>语言</dt>
              <dd>
                {candidate.language} → {state.target?.language}
              </dd>
            </div>
            <div>
              <dt>策略</dt>
              <dd>{state.strategy}</dd>
            </div>
          </dl>
        </section>
      ) : null}
    </aside>
  );
}

export interface AppProps {
  ports: WorkflowPorts;
  moduleTree: ModuleNode;
  searchProvider?: string;
  adaptationProvider?: string;
}

export default function App({
  ports,
  moduleTree,
  searchProvider = 'Mock',
  adaptationProvider = 'Mock',
}: AppProps) {
  const [state, dispatch] = useReducer(workflowReducer, initialWorkflowState);
  const candidate = useMemo(() => selectedCandidate(state), [state]);

  async function handleSearch() {
    if (!state.target) return;
    dispatch({ type: 'SEARCH_START' });
    try {
      const candidates = await ports.search.search({
        target: state.target,
        requirement: state.requirement.trim(),
        topK: state.topK,
        candidateLanguages: adaptationProvider === 'Mock' ? undefined : ['Java'],
      });
      dispatch({ type: 'SEARCH_SUCCESS', candidates });
    } catch (error) {
      dispatch({
        type: 'SEARCH_FAILURE',
        message: error instanceof Error ? error.message : '检索接口调用失败。',
      });
    }
  }

  async function handleAdapt() {
    if (!state.target || !candidate) return;
    dispatch({ type: 'ADAPT_START' });
    try {
      const result = await ports.adaptation.adapt({
        target: state.target,
        candidate,
        requirement: state.requirement,
        strategy: state.strategy,
        decisionNotes: state.decisionNotes,
      });
      dispatch({ type: 'ADAPT_SUCCESS', result });
    } catch (error) {
      dispatch({
        type: 'ADAPT_FAILURE',
        message: error instanceof Error ? error.message : '适配接口调用失败。',
      });
    }
  }

  async function handleApply() {
    if (!state.adaptation) return;
    dispatch({ type: 'APPLY_START' });
    try {
      const result = await ports.backfill.apply(state.adaptation.files);
      dispatch({ type: 'APPLY_SUCCESS', result });
    } catch (error) {
      dispatch({
        type: 'APPLY_FAILURE',
        message: error instanceof Error ? error.message : '回填接口调用失败。',
      });
    }
  }

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="product-mark">
          <span className="product-glyph">FX</span>
          <strong>ForeXplore</strong>
          <span>模块复用工作流</span>
        </div>
        <div className="command-center">
          <Search size={13} />
          <span>搜索模块、方案或工作流命令</span>
          <kbd>Ctrl K</kbd>
        </div>
        <div className="titlebar-meta">
          <span className="mock-state">PROTOTYPE</span>
          <button type="button" aria-label="运行当前流程">
            <Play size={14} />
          </button>
        </div>
      </header>

      <aside className="activity-rail" aria-label="主导航">
        <button type="button" className="is-active" aria-label="模块树">
          <Blocks size={20} />
        </button>
        <button type="button" aria-label="检索仓库">
          <Database size={20} />
        </button>
        <button type="button" aria-label="工作流">
          <Workflow size={20} />
        </button>
        <span className="activity-spacer" />
        <button type="button" aria-label="设置">
          <Settings2 size={20} />
        </button>
      </aside>

      <aside className="explorer-pane">
        <div className="pane-heading">
          <span>模块树</span>
          <PanelLeftClose size={14} />
        </div>
        <div className="explorer-scope">
          <span>WORKSPACE</span>
          <strong>{moduleTree.name}</strong>
        </div>
        <ModuleTree
          root={moduleTree}
          selectedId={state.target?.id ?? null}
          onSelect={(target) => dispatch({ type: 'SELECT_TARGET', target })}
        />
        <div className="explorer-note">
          仅 class / function 可作为工作流目标；文件节点用于导航和上下文组织。
        </div>
      </aside>

      <main className="workspace-pane">
        <WorkflowRail stage={state.stage} />
        {state.error ? <div className="error-banner">{state.error}</div> : null}

        <div className="workspace-content">
          {state.stage === 'target' ? (
            <div className="target-empty-state">
              <span className="empty-state-index">01</span>
              <div>
                <div className="eyebrow">从软件结构开始</div>
                <h1>选择一个需要补齐能力的 class 或 function</h1>
                <p>
                  目标符号会作为后续检索、接口映射、翻译和回填的稳定锚点。当前 C# 树由
                  ModuleSymbolPort 提供，并保留真实路径和签名；后续可替换为 IDE Symbol Provider。
                </p>
              </div>
            </div>
          ) : null}

          {state.stage === 'requirement' ? (
            <RequirementPanel
              state={state}
              dispatch={dispatch}
              onSearch={handleSearch}
              searchProvider={searchProvider}
            />
          ) : null}

          {state.stage === 'candidates' ? (
            <div className="candidate-stage">
              <CandidateBrowser
                candidates={state.candidates}
                selectedId={state.selectedCandidateId}
                sourceLabel={`${searchProvider} Search Port`}
                onSelect={(candidateId) =>
                  dispatch({ type: 'SELECT_CANDIDATE', candidateId })
                }
              />
              <SelectionFooter
                state={state}
                dispatch={dispatch}
                onAdapt={handleAdapt}
                adaptationProvider={adaptationProvider}
              />
            </div>
          ) : null}

          {state.stage === 'adaptation' ? (
            <div className="processing-state">
              <div className="processing-rings" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <div className="eyebrow">CodeAdaptationPort</div>
              <h1>正在生成接口映射与目标实现</h1>
              <p>
                策略：{state.strategy} · {candidate?.language} → {state.target?.language}
              </p>
              <div className="processing-log">
                <span>{adaptationProvider} 正在翻译源实现</span>
                <span>临时 C# skeleton 编译与自动修复</span>
                <span>生成工作区补丁预览</span>
              </div>
            </div>
          ) : null}

          {(state.stage === 'patch' || state.stage === 'complete') && state.adaptation ? (
            <PatchReview
              result={state.adaptation}
              applyResult={state.applyResult}
              applying={state.pending === 'apply'}
              onApply={handleApply}
              onBack={() => dispatch({ type: 'RETURN_TO_CANDIDATES' })}
            />
          ) : null}
        </div>
      </main>

      <Inspector
        state={state}
        searchProvider={searchProvider}
        adaptationProvider={adaptationProvider}
      />

      <footer className="statusbar">
        <span>{moduleTree.name} · main</span>
        <span>检索器：{searchProvider} · 混合</span>
        <span>适配器：{adaptationProvider}</span>
        <span>目标：{state.target?.language ?? '未选择'}</span>
        <span className="statusbar-spacer" />
        <span>Ports 3/3 ready</span>
      </footer>
    </div>
  );
}
