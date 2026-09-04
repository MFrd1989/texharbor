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

test('invites a separate user and enforces role changes and revocation', async ({ page, browser }) => {
  const stamp = Date.now();
  const inviteeEmail = `invited-${stamp}@example.test`;
  await page.goto('/');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.getByLabel('Display name').fill('Project Owner');
  await page.getByLabel('Email address').fill(`owner-${stamp}@example.test`);
  await page.getByLabel('Password').fill('owner-sharing-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: '＋ New project' }).click();
  await page.getByLabel('Project name').fill('Shared Research');
  await page.locator('.dialog').getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /Shared Research/ }).click();
  await expect(page.getByText('● Saved', { exact: true })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByLabel('Email address').fill(inviteeEmail);
  await page.getByLabel('Role').selectOption('editor');
  await page.getByRole('button', { name: 'Create invitation' }).click();
  const invitationUrl = await page.getByLabel('Invitation link').inputValue();
  await page.getByRole('button', { name: 'Close sharing' }).click();

  const intruderContext = await browser.newContext();
  const intruder = await intruderContext.newPage();
  await intruder.goto(new URL(invitationUrl).pathname);
  await intruder.getByRole('button', { name: 'New here? Create an account' }).click();
  await intruder.getByLabel('Display name').fill('Wrong Recipient');
  await intruder.getByLabel('Email address').fill(`intruder-${stamp}@example.test`);
  await intruder.getByLabel('Password').fill('intruder-sharing-password');
  await intruder.getByRole('button', { name: 'Create account' }).click();
  await expect(intruder.getByRole('alert')).toContainText('different email address');
  await intruderContext.close();

  const inviteeContext = await browser.newContext();
  const invitee = await inviteeContext.newPage();
  await invitee.goto(new URL(invitationUrl).pathname);
  await invitee.getByRole('button', { name: 'New here? Create an account' }).click();
  await invitee.getByLabel('Display name').fill('Invited Editor');
  await invitee.getByLabel('Email address').fill(inviteeEmail);
  await invitee.getByLabel('Password').fill('invitee-sharing-password');
  await invitee.getByRole('button', { name: 'Create account' }).click();
  await invitee.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(invitee.getByText('● Saved', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.presence > span')).toHaveCount(2);

  await invitee.locator('.cm-content').click();
  await invitee.keyboard.press('Control+End');
  await invitee.keyboard.type('\nEdit from invited account');
  await expect(page.locator('.cm-content')).toContainText('Edit from invited account');

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByLabel('Role for Invited Editor').selectOption('viewer');
  await expect(invitee.locator('.cm-content')).toHaveAttribute('aria-readonly', 'true', { timeout: 15_000 });
  const projectId = new URL(invitee.url()).pathname.split('/').at(-1)!;
  const filesResponse = await invitee.evaluate(async (id) => (await fetch(`/api/projects/${id}/files`)).json(), projectId) as { files: Array<{ id: string }> };
  const forbiddenStatus = await invitee.evaluate(async ({ id, fileId }) => (await fetch(`/api/projects/${id}/files/${fileId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'forbidden' }) })).status, { id: projectId, fileId: filesResponse.files[0]!.id });
  expect(forbiddenStatus).toBe(403);
  const renameStatus = await invitee.evaluate(async (id) => (await fetch(`/api/projects/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Unauthorized rename' }) })).status, projectId);
  expect(renameStatus).toBe(403);

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(invitee.getByRole('heading', { name: 'Could not open project' })).toBeVisible({ timeout: 15_000 });
  const revokedStatus = await invitee.evaluate(async (id) => (await fetch(`/api/projects/${id}`)).status, projectId);
  expect(revokedStatus).toBe(404);
  await inviteeContext.close();
});
