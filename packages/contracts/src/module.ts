export type Language = 'TypeScript' | 'Python' | 'Java' | 'C#' | 'Rust' | 'Go';

export type ModuleKind =
  | 'workspace'
  | 'folder'
  | 'file'
  | 'class'
  | 'record'
  | 'interface'
  | 'function';

export type ImplementationStatus = 'implemented' | 'unimplemented';

export interface ModuleNode {
  id: string;
  name: string;
  kind: ModuleKind;
  path: string;
  language?: Language;
  signature?: string;
  documentation?: string;
  line?: number;
  implementationStatus?: ImplementationStatus;
  children?: ModuleNode[];
}

export interface ModuleTarget {
  id: string;
  name: string;
  kind: 'class' | 'function' | 'module';
  path: string;
  language: Language;
  signature: string;
  documentation?: string;
  line?: number;
  implementationStatus?: ImplementationStatus;
  /** Complete module boundary when the target is a reviewed project module. */
  module?: {
    repositoryId?: string;
    analysisRevision?: string;
    projectId?: string;
    sourceFiles: string[];
    coreApis: string[];
    dependsOn: string[];
  };
}
