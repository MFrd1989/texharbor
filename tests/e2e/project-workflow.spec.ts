import { expect, test } from '@playwright/test';
import JSZip from 'jszip';

test('creates an account, project, and durably saves source', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  await page.goto('/');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.getByLabel('Display name').fill('E2E Researcher');
  await page.getByLabel('Email address').fill(`e2e-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('end-to-end-test-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'My projects' })).toBeVisible();

  await page.getByRole('button', { name: '＋ New project' }).click();
  await page.getByLabel('Project name').fill('E2E Paper');
  await page.locator('.dialog').getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /E2E Paper/ }).click();

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('\\documentclass{article}\n\\begin{document}\nDurable source\n\\end{document}');
  await expect(page.getByText('● Saved', { exact: true })).toBeVisible({ timeout: 10_000 });

  await page.reload();
  await expect(page.locator('.cm-content')).toContainText('Durable source');
  expect(browserErrors).toEqual([]);
});

test('imports an Overleaf-style ZIP with nested files and binary assets', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.getByLabel('Display name').fill('ZIP Researcher');
  await page.getByLabel('Email address').fill(`zip-e2e-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('zip-end-to-end-password');
  await page.getByRole('button', { name: 'Create account' }).click();

  const zip = new JSZip();
  zip.file('paper/main.tex', '\\documentclass{article}\n\\begin{document}\nImported source\n\\end{document}');
  zip.file('paper/chapters/introduction.tex', 'Nested chapter');
  zip.file('paper/figures/pixel.png', Uint8Array.from([137, 80, 78, 71, 0]));
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await page.locator('input[type="file"]').setInputFiles({ name: 'overleaf-paper.zip', mimeType: 'application/zip', buffer });

  await expect(page.getByText('overleaf-paper', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: /overleaf-paper/ }).click();
  await expect(page.getByRole('button', { name: /main\.tex/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /introduction\.tex/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /pixel\.png/ })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('Imported source');
});

test('synchronizes CRDT edits and awareness between simultaneous editors', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.getByLabel('Display name').fill('Collaboration Researcher');
  await page.getByLabel('Email address').fill(`collaboration-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('collaboration-e2e-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: '＋ New project' }).click();
  await page.getByLabel('Project name').fill('Collaborative Paper');
  await page.locator('.dialog').getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /Collaborative Paper/ }).click();
  await expect(page.getByText('● Saved', { exact: true })).toBeVisible({ timeout: 15_000 });

  const peer = await context.newPage();
  await peer.goto(page.url());
  await expect(peer.getByText('● Saved', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.presence > span')).toHaveCount(2);

  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nSynchronized edit');
  await expect(peer.locator('.cm-content')).toContainText('Synchronized edit');

  await peer.close();
  await expect(page.locator('.presence > span')).toHaveCount(1);
});
