import type { ProjectModule } from './project-analysis';

/** The forest stores file ownership only at leaves; ancestors refer to children. */
export function indexModuleHierarchy(modules: readonly ProjectModule[]) {
  const byId = new Map<string, ProjectModule>();
  const childrenById = new Map<string, ProjectModule[]>();
  const roots: ProjectModule[] = [];
  for (const module of modules) {
    if (!module.id || byId.has(module.id)) throw new Error('Module tree contains a duplicate or empty node ID.');
    byId.set(module.id, module);
    childrenById.set(module.id, []);
  }
  for (const module of modules) {
    if (module.parentId == null) roots.push(module);
    else {
      const children = childrenById.get(module.parentId);
      if (!children || module.parentId === module.id) throw new Error('Module tree contains an invalid parent.');
      children.push(module);
    }
  }
  const depthById = new Map<string, number>();
  const visit = (module: ProjectModule, depth: number) => {
    if (depth > 64 || depthById.has(module.id)) throw new Error('Module tree contains a cycle or excessive depth.');
    depthById.set(module.id, depth);
    const children = childrenById.get(module.id)!;
    if (children.length && (module.sourceFiles.length || module.symbolKeys.length)) throw new Error('Parent modules cannot directly own files or symbols.');
    for (const child of children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  if (depthById.size !== modules.length) throw new Error('Module tree contains an unreachable cycle.');
  const sourceFiles = (moduleId: string, limit = Number.MAX_SAFE_INTEGER): { files: string[]; truncated: boolean } => {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Module file limit must be positive.');
    const root = byId.get(moduleId);
    if (!root) throw new Error('Module node does not exist.');
    const files: string[] = [];
    const seen = new Set<string>();
    const stack = [root];
    let truncated = false;
    while (stack.length) {
      const node = stack.pop()!;
      for (const file of node.sourceFiles) {
        if (seen.has(file)) continue;
        if (files.length === limit) { truncated = true; break; }
        seen.add(file); files.push(file);
      }
      if (truncated) break;
      stack.push(...[...childrenById.get(node.id)!].reverse());
    }
    return { files, truncated };
  };
  return { byId, childrenById, roots, depthById, sourceFiles };
}
