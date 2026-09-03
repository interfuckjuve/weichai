import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/ibm-plex-sans/index.css';
import '@fontsource/ibm-plex-mono/400.css';
import { mockWorkflowPorts } from '@forexplore/mock-adapters';
import { withSeekDbSearch } from '@forexplore/seekdb-adapter';
import { withAdaptationService } from '@forexplore/adaptation-http-adapter';
import {
  csharpWorkspaceId,
  workspaceModuleSymbols,
} from '@forexplore/workspace-adapters';
import type { MigrationRouteDescriptor } from '@forexplore/contracts';
import App from './App';
import './styles.css';

const retrievalApiUrl = import.meta.env.VITE_RETRIEVAL_API_URL?.trim();
const adaptationApiUrl = import.meta.env.VITE_ADAPTATION_API_URL?.trim();
const migrationRoutes = readMigrationRoutes(import.meta.env.VITE_MIGRATION_ROUTES_JSON);

function readMigrationRoutes(value: string | undefined): MigrationRouteDescriptor[] {
  if (!value?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('expected an array');
    return parsed.filter((route): route is MigrationRouteDescriptor =>
      typeof route === 'object' && route !== null &&
      (route as { schemaVersion?: unknown }).schemaVersion === '2.0');
  } catch (error) {
    throw new Error(`VITE_MIGRATION_ROUTES_JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let workflowPorts = mockWorkflowPorts;
if (retrievalApiUrl) {
  workflowPorts = withSeekDbSearch(workflowPorts, { baseUrl: retrievalApiUrl });
}
if (adaptationApiUrl) {
  workflowPorts = withAdaptationService(workflowPorts, { baseUrl: adaptationApiUrl });
}

async function bootstrap() {
  const moduleTree = await workspaceModuleSymbols.loadTree(csharpWorkspaceId);
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App
        ports={workflowPorts}
        moduleTree={moduleTree}
        searchProvider={retrievalApiUrl ? 'SeekDB' : 'Mock'}
        adaptationProvider={adaptationApiUrl ? 'DeepSeek HTTP' : 'Mock'}
        migrationRoutes={migrationRoutes}
      />
    </React.StrictMode>,
  );
}

void bootstrap();
