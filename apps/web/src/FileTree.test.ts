import { describe, expect, it } from 'vitest';
import type { FileDto } from '@texharbor/contracts';
import { buildFileTree } from './FileTree';

const file = (path: string, kind: FileDto['kind']): FileDto => ({ id: path, path, kind, mimeType: null, size: 0, isBinary: path.endsWith('.eps'), updatedAt: '' });

describe('buildFileTree', () => {
  it('groups nested files under folders and sorts folders before files', () => {
    const tree = buildFileTree([
      file('/main.tex', 'file'), file('/Images/plot.eps', 'file'), file('/Chapters/intro.tex', 'file'),
      file('/Images', 'directory'), file('/Chapters', 'directory'), file('/Chapters/nested', 'directory'), file('/Chapters/nested/results.tex', 'file'),
    ]);
    expect(tree.map((node) => node.file.path)).toEqual(['/Chapters', '/Images', '/main.tex']);
    expect(tree[0]!.children.map((node) => node.file.path)).toEqual(['/Chapters/nested', '/Chapters/intro.tex']);
    expect(tree[0]!.children[0]!.children[0]!.file.path).toBe('/Chapters/nested/results.tex');
  });
});
