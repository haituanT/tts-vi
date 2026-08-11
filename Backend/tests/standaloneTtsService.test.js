const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const standaloneTts = require('../services/standaloneTtsService');

test('standalone TTS planner preserves paragraph breaks and Unicode text', () => {
  const segments = standaloneTts.planSegments(
    'Xin chào Việt Nam. Đây là câu thứ hai.\n\nĐoạn mới có tiếng Việt đầy đủ dấu.'
  );

  assert.equal(segments.length, 2);
  assert.equal(segments[0].breakAfter, 'paragraph');
  assert.equal(segments[1].breakAfter, 'none');
  assert.match(segments[1].text, /Việt/);
});

test('standalone TTS planner splits long unpunctuated text without cutting words', () => {
  const text = Array.from({ length: 140 }, (_, index) => `word${index}`).join(' ');
  const segments = standaloneTts.planSegments(text);

  assert.ok(segments.length > 1);
  assert.ok(segments.every((segment) => segment.text.length <= 500));
  assert.equal(segments.map((segment) => segment.text).join(' '), text);
});

test('standalone TTS planner normalizes line endings but keeps blank-line paragraphs', () => {
  const segments = standaloneTts.planSegments('One line\r\ncontinues here.\r\n\r\nSecond paragraph.');

  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, 'One line continues here.');
  assert.equal(segments[0].breakAfter, 'paragraph');
});

test('standalone TTS validation rejects empty and oversized edited segments', () => {
  assert.throws(
    () => standaloneTts._private.validateSegments([{ text: '' }]),
    /empty/
  );
  assert.throws(
    () => standaloneTts._private.validateSegments([{ text: 'x'.repeat(501) }]),
    /exceeds 500/
  );
});

test('standalone TTS output names are sanitized and never overwrite', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dubflow-standalone-test-'));
  try {
    const first = await standaloneTts._private.uniqueOutputPath(directory, 'bad:name?.mp3', 'mp3');
    await fs.writeFile(first, 'first');
    const second = await standaloneTts._private.uniqueOutputPath(directory, 'bad:name?.mp3', 'mp3');

    assert.equal(path.basename(first), 'bad_name_.mp3');
    assert.equal(path.basename(second), 'bad_name__2.mp3');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('standalone TTS provider concurrency honors provider limits', () => {
  assert.equal(standaloneTts._private.providerConcurrency({ ttsProvider: 'unknown_voice', ttsConcurrency: 20 }), 6);
  assert.equal(standaloneTts._private.providerConcurrency({ ttsProvider: 'google_cloud_tts', ttsConcurrency: 20 }), 3);
  assert.equal(standaloneTts._private.providerConcurrency({ ttsProvider: 'edge_tts', ttsConcurrency: 30 }), 20);
  assert.equal(standaloneTts._private.providerConcurrency({ ttsProvider: 'aimax_tts', ttsConcurrency: 30 }), 30);
});
