const { test, expect } = require('@playwright/test');

test.use({
  launchOptions: {
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  },
  viewport: { width: 1440, height: 950 },
});

test('sub editor opens and applies row edits', async ({ page }) => {
  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.addInitScript(() => {
    localStorage.setItem('dubflow.reupStudio.v5', JSON.stringify({
      projectId: 'playwright-subedit-check',
      projectName: 'Sub edit check',
      source: { mode: 'local', videoPath: '', videoUrl: '', title: 'Check video' },
      job: { jobId: 'check-job', durationSeconds: 8, previewVideoUrl: '', sourceVideoUrl: '' },
      rows: [
        { id: 'row-1', index: 1, start: 0, end: 2.5, duration: 2.5, sourceText: 'Dòng gốc 1', translatedText: 'Dòng dịch 1', finalText: 'Dòng phụ đề 1' },
        { id: 'row-2', index: 2, start: 2.5, end: 5, duration: 2.5, sourceText: 'Dòng gốc 2', translatedText: 'Dòng dịch 2', finalText: 'Dòng phụ đề 2' },
        { id: 'row-3', index: 3, start: 5, end: 7.5, duration: 2.5, sourceText: 'Dòng gốc 3', translatedText: 'Dòng dịch 3', finalText: 'Dòng phụ đề 3' },
      ],
      selectedRowId: 'row-2',
      currentTime: 2.5,
      currentStage: 'final',
      busy: false,
      logs: [],
      error: '',
      outputs: {},
      config: {},
      voices: [],
    }));
  });

  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  await page.locator('[data-row-id="row-2"]').click({ button: 'right' });
  await page.getByText('Chỉnh timeline').click();
  await expect(page.getByText('Sub Editor')).toBeVisible();

  await page.getByLabel('Text').fill('Nội dung đã sửa từ Sub Editor');
  await page.getByLabel('Start').fill('2.000');
  await page.getByLabel('End').fill('4.500');
  await page.getByRole('button', { name: 'Apply Sub' }).click();

  await expect(page.getByText('Nội dung đã sửa từ Sub Editor')).toBeVisible();
  await expect(page.getByText('Replace All')).toBeVisible();
  await page.screenshot({ path: 'D:/ai soure/DubFlow/Frontend/sub-editor-check.png', fullPage: true });

  const row = await page.evaluate(() => JSON.parse(localStorage.getItem('dubflow.reupStudio.v5')).rows.find((item) => item.id === 'row-2'));
  expect(row.finalText).toBe('Nội dung đã sửa từ Sub Editor');
  expect(row.start).toBe(2);
  expect(row.end).toBe(4.5);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
