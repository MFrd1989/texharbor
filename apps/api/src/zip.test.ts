import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { readSourceArchive } from './zip.js';

describe('readSourceArchive', () => {
  it('imports text, binary assets, nested folders, and strips one wrapper folder', async () => {
    const zip = new JSZip();
    zip.file('paper/main.tex', '\\documentclass{article}');
    zip.file('paper/chapters/intro.tex', 'Introduction');
    zip.folder('paper/empty');
    zip.file('paper/figures/pixel.png', Uint8Array.from([137, 80, 78, 71, 0]));
    const files = await readSourceArchive(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(files.map((file) => file.path)).toEqual(['/chapters', '/empty', '/figures', '/main.tex', '/chapters/intro.tex', '/figures/pixel.png']);
    expect(files.find((file) => file.path.endsWith('.png'))?.isBinary).toBe(true);
    expect(files.find((file) => file.path === '/main.tex')?.isBinary).toBe(false);
  });

  it('rejects an empty archive', async () => {
    const zip = new JSZip();
    await expect(readSourceArchive(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('does not contain project files');
  });

  it('rejects traversal paths using the original ZIP entry name', async () => {
    const zip = new JSZip();
    zip.file('../secret.tex', 'secret');
    await expect(readSourceArchive(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('Invalid project path');
  });

  it('rejects absolute archive paths', async () => {
    const zip = new JSZip();
    zip.file('/tmp/secret.tex', 'secret');
    await expect(readSourceArchive(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('unsafe absolute path');
  });
});
