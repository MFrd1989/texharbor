import path from 'node:path';

export function safeTarget(root: string, projectPath: string): string {
  const relative = projectPath.replace(/^\/+/, '');
  const target = path.resolve(root, relative);
  if (!relative || !target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`Unsafe project path: ${projectPath}`);
  return target;
}
