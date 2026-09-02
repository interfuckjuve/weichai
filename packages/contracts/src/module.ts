/** @deprecated Use the open-ended `LanguageId` at new boundaries. */
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

/**
 * @deprecated V1 class/function compatibility shape. New migration flows must
 * use `MigrationTargetRef`, whose language and entity kind are open-ended.
 */
export interface ModuleTarget {
  id: string;
  name: string;
  kind: 'class' | 'function';
  path: string;
  language: Language;
  signature: string;
  documentation?: string;
  line?: number;
  implementationStatus?: ImplementationStatus;
}
