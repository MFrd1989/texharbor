import { Fragment, useMemo, useState } from 'react';
import type { FileDto } from '@texlyre/contracts';

export type FileTreeNode = { file: FileDto; children: FileTreeNode[] };

const parentPath = (filePath: string) => filePath.slice(0, filePath.lastIndexOf('/')) || '/';
const compareNodes = (left: FileTreeNode, right: FileTreeNode) => {
  if (left.file.kind !== right.file.kind) return left.file.kind === 'directory' ? -1 : 1;
  return left.file.path.split('/').at(-1)!.localeCompare(right.file.path.split('/').at(-1)!, undefined, { numeric: true, sensitivity: 'base' });
};

export function buildFileTree(files: FileDto[]): FileTreeNode[] {
  const nodes = new Map<string, FileTreeNode>(files.map((file) => [file.path, { file, children: [] }]));
  const roots: FileTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(parentPath(node.file.path));
    if (parent?.file.kind === 'directory') parent.children.push(node);
    else roots.push(node);
  }
  const sort = (items: FileTreeNode[]) => { items.sort(compareNodes); for (const item of items) sort(item.children); };
  sort(roots);
  return roots;
}

export function FileTree({ files, selectedId, editable, onOpen, onRename, onDelete }: {
  files: FileDto[];
  selectedId: string | undefined;
  editable: boolean;
  onOpen: (file: FileDto) => void;
  onRename: (file: FileDto) => void;
  onDelete: (file: FileDto) => void;
}) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (filePath: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(filePath)) next.delete(filePath); else next.add(filePath);
    return next;
  });
  const render = (nodes: FileTreeNode[], depth = 0) => nodes.map((node) => {
    const folder = node.file.kind === 'directory';
    const isCollapsed = collapsed.has(node.file.path);
    const name = node.file.path.split('/').at(-1);
    return <Fragment key={node.file.id}>
      <div className={`tree-row ${folder ? 'folder-row' : 'file-row'}`} data-path={node.file.path} role="treeitem" aria-level={depth + 1} aria-expanded={folder ? !isCollapsed : undefined}>
        <button className={selectedId === node.file.id ? 'selected' : ''} style={{ paddingLeft: `${12 + depth * 16}px` }} title={node.file.path} onClick={() => folder ? toggle(node.file.path) : onOpen(node.file)}>
          <span className="tree-disclosure">{folder ? isCollapsed ? '▸' : '▾' : node.file.isBinary ? '◇' : '▤'}</span> {name}
        </button>
        {editable && <span className="tree-actions"><button title={`Rename ${node.file.path}`} onClick={() => onRename(node.file)}>✎</button><button title={`Delete ${node.file.path}`} onClick={() => onDelete(node.file)}>×</button></span>}
      </div>
      {folder && !isCollapsed && render(node.children, depth + 1)}
    </Fragment>;
  });
  return <div className="file-tree" role="tree" aria-label="Project files">{render(tree)}</div>;
}
