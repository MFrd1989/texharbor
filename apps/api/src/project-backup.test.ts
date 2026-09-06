import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { DatabasePool } from '@texharbor/database';
import { createProjectBackup, readProjectBackup } from './project-backup.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const pool = {
  query: async (sql: string) => {
    if (sql.startsWith('SELECT id, name')) return { rows: [{ id: projectId, name: 'Research Paper', description: 'A paper', main_file_path: '/main.tex', compiler: 'pdflatex' }] };
    return { rows: [
      { id: '1', path: '/figures', kind: 'directory', mime_type: null, content: null, size: '0', is_binary: false },
      { id: '2', path: '/figures/plot.png', kind: 'file', mime_type: 'image/png', content: Buffer.from([137, 80, 78, 71]), size: '4', is_binary: true },
      { id: '3', path: '/main.tex', kind: 'file', mime_type: 'text/x-tex', content: Buffer.from('\\documentclass{article}'), size: '23', is_binary: false },
    ] };
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
