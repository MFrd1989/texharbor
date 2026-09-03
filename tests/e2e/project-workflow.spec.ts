import { expect, test } from '@playwright/test';

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

