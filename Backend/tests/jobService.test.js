const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { readJson } = require('../services/jobService');

test('readJson accepts UTF-8 BOM JSON files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dubflow-json-'));
  const filePath = path.join(directory, 'report.json');
  await fs.writeFile(filePath, `\uFEFF${JSON.stringify({ status: 'warn', issues: [{ code: 'READING_SPEED_TOO_HIGH' }] })}`, 'utf8');

  const parsed = await readJson(filePath, null);

  assert.equal(parsed.status, 'warn');
  assert.equal(parsed.issues[0].code, 'READING_SPEED_TOO_HIGH');
});
