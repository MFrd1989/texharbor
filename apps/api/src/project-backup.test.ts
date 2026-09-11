import JSZip from 'jszip';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DatabasePool } from '@texharbor/database';
import { createProjectBackup, createProjectDeltaBackup, createFullProjectBackup, readProjectBackup } from './project-backup.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const pool = {
  query: async () => {
    return { rows: [
      { id: '1', path: '/figures', kind: 'directory', mime_type: null, content: null, size: '0', is_binary: false },
      { id: '2', path: '/figures/plot.png', kind: 'file', mime_type: 'image/png', content: Buffer.from([137, 80, 78, 71]), size: '4', is_binary: true },
      { id: '3', path: '/main.tex', kind: 'file', mime_type: 'text/x-tex', content: Buffer.from('\\documentclass{article}'), size: '23', is_binary: false },
    ].map((file) => ({ ...file, file_id: file.id, id: projectId, name: 'Research Paper', description: 'A paper', main_file_path: '/main.tex', compiler: 'pdflatex' })) };
  },
} as unknown as DatabasePool;

describe('project cloud backups', () => {
  it('round trips project metadata, nested folders, source, and binary assets', async () => {
    const created = await createProjectBackup(pool, projectId);
    const restored = await readProjectBackup(created.archive, projectId);
    expect(restored.manifest.project.name).toBe('Research Paper');
    expect(restored.files.map((file) => file.path)).toEqual(['/figures', '/figures/plot.png', '/main.tex']);
    expect(restored.files.find((file) => file.path.endsWith('.png'))?.content).toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it('rejects cross-project restores and altered content', async () => {
    const created = await createProjectBackup(pool, projectId);
    await expect(readProjectBackup(created.archive, '22222222-2222-4222-8222-222222222222')).rejects.toThrow('does not belong');
    const zip = await JSZip.loadAsync(created.archive);
    zip.file('project/main.tex', 'tampered');
    const altered = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(readProjectBackup(altered, projectId)).rejects.toThrow('integrity check failed');
  });
});

describe('incremental project history', () => {
  const parentId = '33333333-3333-4333-8333-333333333333';
  const asset = randomBytes(256 * 1024);
  const original = randomBytes(128 * 1024).toString('hex');
  const build = (main: string, options: { renamed?: boolean; removed?: boolean; description?: string; extra?: boolean } = {}) => createProjectBackup({
    query: async () => {
      return { rows: [
        ...(!options.removed ? [{ path: options.renamed ? '/renamed.png' : '/asset.png', kind: 'file', mime_type: 'image/png', content: asset, is_binary: true }] : []),
        ...(options.extra ? [{ path: '/extra.tex', kind: 'file', mime_type: 'text/plain', content: Buffer.from('new file'), is_binary: false }] : []),
        { path: '/main.tex', kind: 'file', mime_type: 'text/plain', content: Buffer.from(main), is_binary: false },
      ].sort((a, b) => a.path.localeCompare(b.path)).map((file) => ({ ...file, file_id: file.path, id: projectId, name: 'Paper', description: options.description || '', main_file_path: '/main.tex', compiler: 'pdflatex' })) };
    },
  } as unknown as DatabasePool, projectId);

  it('stores a small within-file diff without duplicating unchanged assets', async () => {
    const base = await build(original);
    const next = await build(`${original.slice(0, 10000)}edited${original.slice(10000)}`);
    const delta = await createProjectDeltaBackup(next, base, parentId);
    expect(delta.archive.length).toBeLessThan(base.archive.length / 100);
    const zip = await JSZip.loadAsync(delta.archive);
    expect(zip.file('project/asset.png')).toBeNull();
    expect(zip.file('project/main.tex')).toBeNull();
    expect(zip.file('delta/main.tex')).not.toBeNull();
    const restored = await readProjectBackup(delta.archive, projectId, base, parentId);
    expect(restored.files.map((file) => file.sha256)).toEqual(next.files.map((file) => file.sha256));
    expect(restored.files.every((file, index) => file.content?.equals(next.files[index]!.content!))).toBe(true);
    expect(restored.manifest.sourceHash).toBe(next.manifest.sourceHash);
  });

  it('reconstructs renames, adds, deletions, empty files and metadata changes across versions', async () => {
    const base = await build(original);
    const renamed = await build(original, { renamed: true, extra: true, description: 'renamed' });
    const first = await createProjectDeltaBackup(renamed, base, parentId);
    expect((await JSZip.loadAsync(first.archive)).file('project/renamed.png')).toBeNull();
    const restored = await readProjectBackup(first.archive, projectId, base, parentId);
    expect(restored.files.map((file) => [file.path, file.sha256])).toEqual(renamed.files.map((file) => [file.path, file.sha256]));
    const emptied = await build('', { removed: true });
    const second = await createProjectDeltaBackup(emptied, restored, parentId);
    const final = await readProjectBackup(second.archive, projectId, restored, parentId);
    expect(final.files).toEqual(emptied.files);
    // Pruning can materialize a surviving version without its former parents.
    expect((await readProjectBackup(await createFullProjectBackup(final), projectId)).files).toEqual(emptied.files);
  });

  it('rejects missing/wrong parents, corrupt patches, and altered project metadata', async () => {
    const base = await build(original);
    const next = await build(`${original}change`);
    const delta = await createProjectDeltaBackup(next, base, parentId);
    await expect(readProjectBackup(delta.archive, projectId)).rejects.toThrow('parent');
    await expect(readProjectBackup(delta.archive, projectId, next, parentId)).rejects.toThrow('parent');
    await expect(readProjectBackup(delta.archive, projectId, base, projectId)).rejects.toThrow('parent');
    const zip = await JSZip.loadAsync(delta.archive);
    zip.file('delta/main.tex', '[[999999999,1]]');
    await expect(readProjectBackup(await zip.generateAsync({ type: 'nodebuffer' }), projectId, base, parentId)).rejects.toThrow('outside');
    const metadataZip = await JSZip.loadAsync(delta.archive);
    metadataZip.file('texharbor.json', JSON.stringify({ ...delta.manifest, project: { ...delta.manifest.project, name: 'tampered' } }));
    await expect(readProjectBackup(await metadataZip.generateAsync({ type: 'nodebuffer' }), projectId, base, parentId)).rejects.toThrow('project integrity');
  });
});
