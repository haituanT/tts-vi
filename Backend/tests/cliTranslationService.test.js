const test = require('node:test');
const assert = require('node:assert/strict');

const { _private } = require('../services/cliTranslationService');

test('CLI stream collector preserves UTF-8 characters split across chunks', () => {
  const expected = 'Đây là một dòng tiếng Việt có dấu.';
  const bytes = Buffer.from(expected, 'utf8');
  const collector = _private.createUtf8StreamCollector();

  for (let index = 0; index < bytes.length; index += 1) {
    collector.write(bytes.subarray(index, index + 1));
  }

  assert.equal(collector.end(), expected);
});

test('CLI stream collector falls back to a Windows code page for AGY output', () => {
  const expected = 'Café done.';
  const bytes = Buffer.concat([
    Buffer.from('Caf', 'ascii'),
    Buffer.from([0xe9]),
    Buffer.from(' ', 'ascii'),
    Buffer.from('done.', 'ascii'),
  ]);
  const collector = _private.createUtf8StreamCollector(['windows-1252']);

  collector.write(bytes.subarray(0, 4));
  collector.write(bytes.subarray(4));

  assert.equal(collector.end(), expected);
});

test('AGY parser rejects unrecovered replacement characters so DB fallback can run', () => {
  assert.throws(
    () => _private.parseAntigravityOutput('[{"translation_merged":"C\uFFFD phê"}]'),
    /invalid text encoding/
  );
});

test('AGY prompt compaction removes verbose references before Windows spawn', () => {
  const prompt = [
    'core skill and input',
    '\r\n\r\n---\r\n\r\n# Vietnamese Narration Style',
    'verbose reference '.repeat(2000),
    '\r\n\r\n---\r\n\r\n# Vietnamese TTS Reading Rules',
    'km -> cây số',
    '\r\n\r\n---\r\n\r\n# Prompt 2 Template',
    'verbose template '.repeat(2000),
  ].join('');
  const compact = _private.compactAntigravityPrompt(prompt);

  assert.ok(compact.length < 24000);
  assert.equal(compact.includes('# Vietnamese Narration Style'), false);
  assert.equal(compact.includes('# Prompt 2 Template'), false);
  const shortDefault = _private.buildCodexArgs('', 'short prompt');
  assert.ok(shortDefault.includes('--ephemeral'));
  assert.equal(shortDefault.includes('model_reasoning_effort="high"'), false);

  const longPrompt = _private.buildCodexArgs('', 'x'.repeat(24 * 1024));
  assert.ok(longPrompt.includes('--ephemeral'));
  assert.ok(longPrompt.includes('model_reasoning_effort="high"'));

  const explicitModel = _private.buildCodexArgs('gpt-5.4-mini', 'short prompt');
  assert.ok(explicitModel.includes('--model'));
  assert.ok(explicitModel.includes('gpt-5.4-mini'));
  assert.ok(explicitModel.includes('model_reasoning_effort="high"'));
  assert.ok(compact.includes('# Vietnamese TTS Reading Rules'));
  assert.ok(compact.includes('km -> cây số'));
});
