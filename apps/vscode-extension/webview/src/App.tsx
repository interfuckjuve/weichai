import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Settings2 } from 'lucide-react';
import type { RepositoryStatus, ServiceStatus } from '../../src/ui-types';
import type { ModuleExplorerMode, ModuleExplorerNode } from '../../src/ui-types';
import {
  initialWorkflowState,
  getStepStatus,
  selectedCandidate,
  workflowReducer,
  type WorkflowStage,
  type WorkflowState,
} from '@forexplore/workflow-core';
import type { PanelInitPayload, PanelSettingsPresentation } from '../../src/protocol/messages';
import { AdaptationStage } from './components/AdaptationStage';
import { CandidatesStage } from './components/CandidatesStage';
import { FooterStatus } from './components/FooterStatus';
import { PatchStage } from './components/PatchStage';
import { RequirementStage } from './components/RequirementStage';
import { StepRail } from './components/StepRail';
import { ModuleWorkspace } from './components/ModuleWorkspace';
import { SettingsPanel } from './components/SettingsPanel';
import { errorEvent } from './errors';
import { createMessageBus, type MessageBus } from './vscode-api';

export default function App() {
  const bus: MessageBus = useMemo(() => createMessageBus(), []);
  const [state, dispatch] = useReducer(workflowReducer, initialWorkflowState);
  const [payload, setPayload] = useState<PanelInitPayload | null>(null);
  const [repositoryStatuses, setRepositoryStatuses] = useState<RepositoryStatus[]>([]);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
  const [moduleExplorer, setModuleExplorer] = useState<PanelInitPayload['moduleExplorer'] | null>(null);
  const [explorerMode, setExplorerMode] = useState<ModuleExplorerMode>('target');
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [refreshingExplorer, setRefreshingExplorer] = useState(false);
  const [visibleStep, setVisibleStep] = useState<WorkflowStage>('target');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<WorkflowState['pending']>(null);
  const targetIdRef = useRef<string | null>(null);
  const settingsRef = useRef<PanelSettingsPresentation>({ repositoryPaths: [], topK: 4 });
  pendingRef.current = state.pending;
  targetIdRef.current = state.target?.id ?? null;

  useEffect(() => {
    bus.post({ type: 'READY' });
    return bus.subscribe((message) => {
      switch (message.type) {
        case 'INIT':
          settingsRef.current = message.payload.settings;
          setPayload(message.payload);
          setRepositoryStatuses(message.payload.repositoryStatuses);
          setServiceStatus(message.payload.serviceStatus);
          setModuleExplorer(message.payload.moduleExplorer);
          setHistoryId((current) => current ?? message.payload.moduleExplorer.history[0]?.id ?? null);
          setError(null);
          if (targetIdRef.current !== message.payload.target.id) {
            dispatch({ type: 'SELECT_TARGET', target: message.payload.target });
            setVisibleStep('requirement');
          }
          dispatch({ type: 'SET_TOP_K', value: message.payload.settings.topK });
          break;
        case 'SEARCH_RESULT':
          dispatch({ type: 'SEARCH_SUCCESS', candidates: message.candidates });
          break;
        case 'ADAPT_RESULT':
          dispatch({ type: 'ADAPT_SUCCESS', result: message.result });
          break;
        case 'APPLY_RESULT':
          dispatch({ type: 'APPLY_SUCCESS', result: message.result });
          break;
        case 'REPOSITORY_STATUS':
          setRepositoryStatuses(message.statuses);
          break;
        case 'SERVICE_STATUS':
          setServiceStatus(message.status);
          break;
        case 'MODULE_EXPLORER':
          setModuleExplorer(message.explorer);
          setHistoryId((current) =>
            message.explorer.history.some((repository) => repository.id === current)
              ? current
              : message.explorer.history[0]?.id ?? null,
          );
          setRefreshingExplorer(false);
          break;
        case 'TARGET_SELECTED':
          setPayload((current) => current ? { ...current, target: message.target } : current);
          if (targetIdRef.current !== message.target.id) {
            dispatch({ type: 'SELECT_TARGET', target: message.target });
            dispatch({ type: 'SET_TOP_K', value: settingsRef.current.topK });
            setVisibleStep('requirement');
          }
          setExplorerMode('target');
          setSelectedNodeId(null);
          setSettingsOpen(false);
          break;
        case 'SETTINGS_UPDATED':
          settingsRef.current = message.settings;
          setPayload((current) => current ? { ...current, settings: message.settings } : current);
          dispatch({ type: 'SET_TOP_K', value: message.settings.topK });
          setSettingsSaving(false);
          setSettingsOpen(false);
          break;
        case 'ERROR': {
          setError(message.message);
          setRefreshingExplorer(false);
          setSettingsSaving(false);
          const event = errorEvent(pendingRef.current, message.message);
          if (event) dispatch(event);
          break;
        }
      }
    });
  }, [bus]);

  useEffect(() => {
    setVisibleStep(state.stage === 'complete' ? 'patch' : state.stage);
  }, [state.stage]);

  function handleSearch(): void {
    if (!state.target) return;
    setError(null);
    dispatch({ type: 'SEARCH_START' });
    bus.post({
      type: 'START_SEARCH',
      requirement: state.requirement.trim(),
      topK: state.topK,
    });
  }

  function handleAdapt(): void {
    const candidate = selectedCandidate(state);
    if (!state.target || !candidate) return;
    setError(null);
    dispatch({ type: 'ADAPT_START' });
    bus.post({
      type: 'START_ADAPT',
      decisionNotes: state.decisionNotes,
    });
  }

  function handleApply(): void {
    if (!state.adaptation) return;
    setError(null);
    dispatch({ type: 'APPLY_START' });
    bus.post({ type: 'APPLY_CURRENT_RUN' });
  }

  function handleCheckRepositories(): void {
    setError(null);
    bus.post({ type: 'CHECK_REPOSITORIES' });
  }

  function handleSelectCandidate(candidateId: string): void {
    dispatch({ type: 'SELECT_CANDIDATE', candidateId });
    bus.post({ type: 'SELECT_CANDIDATE', candidateId });
  }

  function handleOpenTarget(): void {
    bus.post({ type: 'OPEN_TARGET' });
  }

  function handleCopyTargetPath(): void {
    bus.post({ type: 'COPY_TARGET_PATH' });
  }

  function handleRevealTargetInExplorer(): void {
    bus.post({ type: 'REVEAL_TARGET_IN_EXPLORER' });
  }

  function handleRefreshModuleExplorer(): void {
    setError(null);
    setRefreshingExplorer(true);
    bus.post({ type: 'REFRESH_MODULE_EXPLORER' });
  }

  function handleSaveSettings(settings: PanelSettingsPresentation): void {
    setError(null);
    setSettingsSaving(true);
    bus.post({ type: 'SAVE_SETTINGS', settings });
  }

  function handleSelectWorkspaceTarget(targetId: string): void {
    if (targetId === state.target?.id) return;
    setError(null);
    bus.post({ type: 'SELECT_WORKSPACE_TARGET', targetId });
  }

  function handleExplorerModeChange(mode: ModuleExplorerMode): void {
    setSettingsOpen(false);
    setExplorerMode(mode);
    setSelectedNodeId(null);
    if (
      mode === 'history' &&
      moduleExplorer?.history.some((repository) => repository.loading) &&
      !refreshingExplorer
    ) {
      handleRefreshModuleExplorer();
    }
  }

  function handleStepChange(step: WorkflowStage): void {
    if (getStepStatus(step, state.stage) === 'upcoming') return;
    setExplorerMode('target');
    setSettingsOpen(false);
    setVisibleStep(step);
  }

  if (!payload || !state.target || !moduleExplorer) {
    return (
      <div className="app">
        <div className="loading-state">正在初始化 ForeXplore 翻译面板…</div>
      </div>
    );
  }

  const candidate = selectedCandidate(state);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-glyph">FX</span>
          <strong>ForeXplore</strong>
        </div>
        <StepRail
          stage={state.stage}
          activeStep={visibleStep}
          onStepChange={handleStepChange}
        />
        <button
          type="button"
          className={`header-settings-button${settingsOpen ? ' is-active' : ''}`}
          onClick={() => setSettingsOpen((open) => !open)}
          aria-pressed={settingsOpen}
        >
          <Settings2 size={14} /> 设置
        </button>
      </header>

      <ModuleWorkspace
        explorer={moduleExplorer}
        mode={explorerMode}
        historyId={historyId}
        currentTargetId={state.target.id}
        selectedNodeId={selectedNodeId}
        refreshing={refreshingExplorer}
        onModeChange={handleExplorerModeChange}
        onHistoryChange={(id) => { setHistoryId(id); setSelectedNodeId(null); }}
        onNodeSelect={(node: ModuleExplorerNode) => { setSelectedNodeId(node.id); setSettingsOpen(false); }}
        onTargetSelect={handleSelectWorkspaceTarget}
        onRefresh={handleRefreshModuleExplorer}
        onOpenSettings={() => setSettingsOpen(true)}
        settingsOpen={settingsOpen}
      >
        {error ? (
          <div className="error-banner" role="alert">
            {error}
          </div>
        ) : null}

        {settingsOpen ? (
          <SettingsPanel
            topK={payload.settings.topK}
            repositoryPaths={payload.settings.repositoryPaths}
            repositoryStatuses={repositoryStatuses}
            saving={settingsSaving}
            onCheckRepositories={handleCheckRepositories}
            onSave={handleSaveSettings}
            onCancel={() => setSettingsOpen(false)}
          />
        ) : (
          <main className="stage-body">
            {visibleStep === 'requirement' ? (
              <RequirementStage
                key={state.target.id}
                state={state}
                target={state.target}
                dispatch={dispatch}
                onSearch={handleSearch}
                onCopyTargetPath={handleCopyTargetPath}
                onRevealTarget={handleRevealTargetInExplorer}
              />
            ) : null}

            {visibleStep === 'candidates' ? (
              <CandidatesStage
                state={state}
                dispatch={dispatch}
                adaptationProvider={payload.adaptationProvider}
                onSelectCandidate={handleSelectCandidate}
                onAdapt={handleAdapt}
              />
            ) : null}

            {visibleStep === 'adaptation' ? (
              <AdaptationStage state={state} candidate={candidate} />
            ) : null}

            {visibleStep === 'patch' && state.adaptation ? (
              <PatchStage
                state={state}
                onApply={handleApply}
                onBack={() => dispatch({ type: 'RETURN_TO_CANDIDATES' })}
                onOpenTarget={handleOpenTarget}
              />
            ) : null}
          </main>
        )}
      </ModuleWorkspace>

      <FooterStatus
        serviceStatus={serviceStatus}
        repositoryStatuses={repositoryStatuses}
        workspaceRoot={payload.workspaceRoot}
      />
    </div>
  );
}
