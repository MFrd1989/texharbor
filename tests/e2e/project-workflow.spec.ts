import { expect, test } from '@playwright/test';
import JSZip from 'jszip';

test('creates an account, keeps a persistent session, and durably saves source', async ({ page, context }) => {
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
  const session = (await context.cookies()).find((cookie) => cookie.name === 'texharbor_session');
  expect(session?.httpOnly).toBe(true);
  expect(session?.secure).toBe(true);
  expect(session?.expires || 0).toBeGreaterThan(Date.now() / 1000 + 170 * 24 * 60 * 60);
  await context.clearCookies();
  await context.addCookies([{ ...session!, name: 'texlyre_session' }]);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'My projects' })).toBeVisible();
  const migratedCookies = await context.cookies();
  expect(migratedCookies.some((cookie) => cookie.name === 'texharbor_session')).toBe(true);
  expect(migratedCookies.some((cookie) => cookie.name === 'texlyre_session')).toBe(false);

  await page.getByRole('button', { name: '＋ New project' }).click();
  await page.getByLabel('Project name').fill('E2E Paper');
  await page.locator('.dialog').getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /E2E Paper/ }).click();

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('\\documentclass{article}\n\\usepackage{algorithm}\n\\usepackage{algorithmic}\n\\begin{document}\nDurable source\n\\begin{algorithm}\n\\begin{algorithmic}\n\\STATE Compile this project.\n\\end{algorithmic}\n\\end{algorithm}\n\\end{document}');
  await expect(page.getByText('● Saved', { exact: true })).toBeVisible({ timeout: 10_000 });

  await page.reload();
  await expect(page.locator('.cm-content')).toContainText('Durable source');
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.getByLabel(/PDF page 1\. Click to open source/)).toBeVisible({ timeout: 30_000 });
  const projectId = new URL(page.url()).pathname.split('/').at(-1)!;
  const latestBuild = await page.evaluate(async (id) => {
    const response = await fetch(`/api/projects/${id}/compile`);
    return (await response.json()).jobs[0] as { id: string; status: string; hasPdf: boolean };
  }, projectId);
  expect(latestBuild.status).toBe('completed');
  expect(latestBuild.hasPdf).toBe(true);
  const pdf = await page.request.get(`/api/projects/${projectId}/compile/${latestBuild.id}/pdf`);
  expect(pdf.ok()).toBe(true);
  expect(pdf.headers()['content-type']).toContain('application/pdf');

  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('\\documentclass{article}\n\\begin{document}\nBefore \\undefinedcommand after a recoverable error.\n\\end{document}');
  await expect(editor).toContainText('\\end{document}');
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.locator('.job-state')).toHaveText('completed with errors', { timeout: 30_000 });
  await expect(page.getByLabel(/PDF page 1\. Click to open source/)).toBeVisible();
  await page.getByRole('button', { name: 'Logs' }).click();
  await expect(page.locator('.build-log')).toContainText('Undefined control sequence');
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
  zip.file('paper/main.tex', '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\nImported source\n\\includegraphics[width=2cm]{figures/plot.eps}\n\\newpage\nSecond PDF page\n\\end{document}');
  zip.file('paper/chapters/introduction.tex', 'Nested chapter');
  zip.file('paper/chapters/sections/results.tex', 'Deeply nested chapter');
  zip.folder('paper/empty');
  zip.file('paper/figures/pixel.png', Uint8Array.from([137, 80, 78, 71, 0]));
  zip.file('paper/figures/plot.eps', '%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 120 80\nnewpath 10 10 moveto 110 10 lineto 110 70 lineto 10 70 lineto closepath 0.15 0.55 0.35 setrgbcolor fill\nshowpage\n%%EOF\n');
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await page.locator('input[type="file"]').setInputFiles({ name: 'overleaf-paper.zip', mimeType: 'application/zip', buffer });

  await expect(page.getByText('overleaf-paper', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: /overleaf-paper/ }).click();
  await expect(page.getByRole('button', { name: /main\.tex/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /introduction\.tex/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /results\.tex/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /plot\.eps/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /pixel\.png/ })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('Imported source');
  const paths = await page.locator('.tree-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-path')));
  expect(paths).toEqual(['/chapters', '/chapters/sections', '/chapters/sections/results.tex', '/chapters/introduction.tex', '/empty', '/figures', '/figures/pixel.png', '/figures/plot.eps', '/main.tex']);
  await page.locator('.tree-row[data-path="/chapters"] > button').click();
  await expect(page.getByRole('button', { name: /introduction\.tex/ })).not.toBeVisible();
  await page.locator('.tree-row[data-path="/chapters"] > button').click();
  await expect(page.getByRole('button', { name: /introduction\.tex/ })).toBeVisible();
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  const pdfCanvas = page.getByLabel(/PDF page 1\. Click to open source/);
  await expect(pdfCanvas).toBeVisible({ timeout: 30_000 });
  const pdfScroller = page.locator('.pdf-canvas-scroll');
  await expect(pdfScroller.locator('.pdf-page')).toHaveCount(2);
  expect(await pdfScroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await pdfScroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByRole('spinbutton', { name: 'PDF page' })).toHaveValue('2');
  await page.getByRole('button', { name: /introduction\.tex/ }).click();
  await expect(page.locator('.cm-content')).toContainText('Nested chapter');
  await page.getByRole('button', { name: 'Expand PDF' }).click();
  await expect(page.locator('.build-panel')).toHaveClass(/pdf-expanded/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.build-panel')).not.toHaveClass(/pdf-expanded/);
  await pdfCanvas.click({ position: { x: 100, y: 100 } });
  await expect(page.locator('.tabbar')).toContainText('/main.tex');
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.getByRole('button', { name: 'Logs' }).click();
  await expect(page.locator('.build-log')).toContainText(/plot-eps-conve\s*rted-to\.pdf/);
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
  const invitationEmail = page.getByLabel('Email address');
  await invitationEmail.fill(inviteeEmail);
  await page.getByLabel('Role').selectOption('editor');
  await page.getByRole('button', { name: 'Create invitation' }).click();
  await expect(page.getByRole('status')).toContainText('Invitation created');
  await expect(invitationEmail).toHaveValue('');
  await expect(page.locator('.share-dialog').getByRole('alert')).toHaveCount(0);
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

  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.down('Shift');
  for (let index = 0; index < 8; index += 1) await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await page.getByRole('button', { name: '＋ Comment on selection' }).click();
  await expect(page.locator('.comment-compose blockquote')).not.toBeEmpty();
  await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Please cite this section.');
  await page.locator('.comment-compose').getByRole('button', { name: 'Comment' }).click();
  await expect(page.getByText('Please cite this section.')).toBeVisible();
  await invitee.getByRole('button', { name: 'Comments', exact: true }).click();
  await expect(invitee.getByText('Please cite this section.')).toBeVisible();
  await invitee.getByLabel(/Reply to comment/).fill('Citation added.');
  await invitee.getByRole('button', { name: 'Send' }).click();
  await expect(invitee.getByText('Citation added.')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh comments' }).click();
  await expect(page.getByText('Citation added.')).toBeVisible();
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByText('Please cite this section.')).not.toBeVisible();
  await page.getByLabel('Resolved').check();
  await expect(page.getByText('Please cite this section.')).toBeVisible();
  await page.getByRole('button', { name: 'Reopen' }).click();
  await page.getByRole('button', { name: 'Close comments' }).click();
  await invitee.getByRole('button', { name: 'Close comments' }).click();
  await page.reload();
  await expect(page.getByText('● Saved', { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Comments', exact: true }).click();
  await expect(page.getByText('Please cite this section.')).toBeVisible();
  await expect(page.getByText('Citation added.')).toBeVisible();
  await page.getByRole('button', { name: '/main.tex' }).click();
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.getByRole('button', { name: 'Close comments' }).click();

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByLabel('Role for Invited Editor').selectOption('viewer');
  await expect(invitee.locator('.cm-content')).toHaveAttribute('aria-readonly', 'true', { timeout: 15_000 });
  const projectId = new URL(invitee.url()).pathname.split('/').at(-1)!;
  const filesResponse = await invitee.evaluate(async (id) => (await fetch(`/api/projects/${id}/files`)).json(), projectId) as { files: Array<{ id: string }> };
  const forbiddenStatus = await invitee.evaluate(async ({ id, fileId }) => (await fetch(`/api/projects/${id}/files/${fileId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'forbidden' }) })).status, { id: projectId, fileId: filesResponse.files[0]!.id });
  expect(forbiddenStatus).toBe(403);
  const renameStatus = await invitee.evaluate(async (id) => (await fetch(`/api/projects/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Unauthorized rename' }) })).status, projectId);
  expect(renameStatus).toBe(403);
  const compileStatus = await invitee.evaluate(async (id) => (await fetch(`/api/projects/${id}/compile`, { method: 'POST' })).status, projectId);
  expect(compileStatus).toBe(403);

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(invitee.getByRole('heading', { name: 'Could not open project' })).toBeVisible({ timeout: 15_000 });
  const revokedStatus = await invitee.evaluate(async (id) => (await fetch(`/api/projects/${id}`)).status, projectId);
  expect(revokedStatus).toBe(404);
  await inviteeContext.close();
  await page.getByRole('button', { name: 'Close sharing' }).click();
  await page.getByRole('button', { name: 'Comments', exact: true }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete thread' }).click();
  await expect(page.getByText('Please cite this section.')).not.toBeVisible();
});

test('provides a mobile workspace without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.getByLabel('Display name').fill('Mobile Researcher');
  await page.getByLabel('Email address').fill(`mobile-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('mobile-end-to-end-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'My projects' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole('button', { name: '＋ New project' }).click();
  await page.getByLabel('Project name').fill('Mobile Paper');
  await page.locator('.dialog').getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /Mobile Paper/ }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace panels' })).toBeVisible();
  await expect(page.locator('.source-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.locator('.file-panel')).toBeVisible();
  await expect(page.locator('.source-panel')).toBeHidden();
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  await expect(page.locator('.build-panel')).toBeVisible();
  await expect(page.locator('.file-panel')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
