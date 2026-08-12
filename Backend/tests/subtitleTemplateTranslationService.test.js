const test = require('node:test');
const assert = require('node:assert/strict');

const { _private } = require('../services/subtitleTemplateTranslationService');

const chunk = [
  {
    group_id: 'template-0001',
    text: 'The Sahara covers about 9.32 million square kilometers.',
  },
];

test('template translation prompt loads the subtitle translation skill', () => {
  const prompt = _private.buildTemplateTranslationPrompt(chunk, {
    sourceLanguage: 'en',
    targetLanguage: 'vi',
  });

  assert.ok(prompt.includes('Skill: subtitle-translation-prompt'));
  assert.ok(prompt.includes('# Vietnamese Narration Style'));
  assert.ok(prompt.includes('## Locked Proper Names And Latin Spelling'));
  assert.ok(prompt.includes('## Natural Pause Punctuation for TTS'));
  assert.ok(prompt.includes('Cova dels Arquets'));
  assert.ok(prompt.includes('never translate, Vietnamese-ize, phoneticize, respell'));
  assert.ok(prompt.includes('use a comma or a full stop at the natural boundary'));
  assert.ok(prompt.includes('not necessarily one completed sentence'));
  assert.ok(prompt.includes('do not restart the subject or force a full stop'));
  assert.ok(prompt.includes('Never remove punctuation mechanically'));
  assert.ok(prompt.includes('# Vietnamese TTS Reading Rules'));
  assert.ok(prompt.includes('# Prompt 2 Template'));
  assert.ok(prompt.includes('km -> cây số'));
  assert.ok(prompt.includes('km/h -> cây số trên giờ'));
  assert.ok(prompt.includes('km2/km² -> ki lô mét vuông'));
  assert.ok(prompt.includes('m/s -> mét trên giây'));
  assert.ok(prompt.includes('CNY/RMB/NDT/¥ -> tệ'));
  assert.ok(prompt.includes('GB -> ghi ga bai'));
  assert.ok(prompt.includes('kW -> ki lô oát'));
  assert.ok(prompt.includes('thứ 1 -> thứ nhất'));
  assert.ok(prompt.includes('Mbps -> mê ga bit trên giây'));
  assert.ok(prompt.includes('MB/s -> mê ga bai trên giây'));
  assert.ok(prompt.includes('fps -> khung hình trên giây'));
  assert.ok(prompt.includes('mmHg -> mi li mét thủy ngân'));
  assert.ok(prompt.includes('mAh -> mi li ampe giờ'));
  assert.ok(prompt.includes('AUD -> đô Úc'));
  assert.equal(/km2[^\n]*cây số vuông/u.test(prompt), false);
  assert.equal(/9,32[^\n]*cây số vuông/u.test(prompt), false);
});

test('template translation chunks include neighboring context without requiring context output', () => {
  const input = [
    { group_id: 'template-0001', text: 'The truck stopped in the desert.' },
    { group_id: 'template-0002', text: 'There was no phone signal.' },
    { group_id: 'template-0003', text: 'Their water was already gone.' },
    { group_id: 'template-0004', text: 'They had to walk for help.' },
  ];
  const windows = _private.buildChunkWindows(input, 2, { translationChunkContextGroups: 1 });

  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0].items.map((item) => item.group_id), ['template-0001', 'template-0002']);
  assert.deepEqual(windows[0].contextAfter.map((item) => item.group_id), ['template-0003']);
  assert.deepEqual(windows[1].contextBefore.map((item) => item.group_id), ['template-0002']);

  const prompt = _private.buildTemplateTranslationPrompt(windows[1].items, {
    sourceLanguage: 'en',
    targetLanguage: 'vi',
  }, null, windows[1]);
  assert.ok(prompt.includes('context_before'));
  assert.ok(prompt.includes('items_to_translate'));
  assert.ok(prompt.includes('context_after'));
  assert.ok(prompt.includes('Do not include context_before or context_after group IDs'));
  assert.ok(prompt.includes('template-0002'));
  assert.ok(prompt.includes('template-0003'));
  assert.ok(prompt.includes('template-0004'));
});

test('template translation rebalances a tiny trailing batch', () => {
  const input = Array.from({ length: 14 }, (_, index) => ({
    group_id: `template-${String(index + 1).padStart(4, '0')}`,
    text: `Source line ${index + 1}`,
  }));
  const windows = _private.buildChunkWindows(input, 12, { translationChunkContextGroups: 0 });

  assert.deepEqual(windows.map((window) => window.items.length), [7, 7]);
  assert.deepEqual(
    windows.flatMap((window) => window.items.map((item) => item.group_id)),
    input.map((item) => item.group_id),
  );
});

test('template translation rejects Chinese characters in Vietnamese output', () => {
  assert.throws(
    () => _private.parseTemplateTranslation(JSON.stringify([
      { group_id: 'template-0001', translation_merged: 'Một ngày sau, lực lượng cứu hộ廷 tới.' },
    ]), chunk, 'fake', { targetLanguage: 'vi' }),
    /Chinese Han\/Hanzi\/Kanji/
  );
});

test('template translation rejects context or duplicate group output', () => {
  assert.throws(
    () => _private.parseTemplateTranslation(JSON.stringify([
      { group_id: 'template-0001', translation_merged: 'Chiáº¿c xe dá»«ng giá»¯a sa máº¡c.' },
      { group_id: 'template-context', translation_merged: 'DÃ²ng ngá»¯ cáº£nh khÃ´ng Ä‘Æ°á»£c tráº£.' },
    ]), chunk, 'fake', { targetLanguage: 'vi' }),
    /unexpected template group/
  );

  assert.throws(
    () => _private.parseTemplateTranslation(JSON.stringify([
      { group_id: 'template-0001', translation_merged: 'Chiáº¿c xe dá»«ng giá»¯a sa máº¡c.' },
      { group_id: 'template-0001', translation_merged: 'Má»™t báº£n dá»‹ch khÃ¡c.' },
    ]), chunk, 'fake', { targetLanguage: 'vi' }),
    /duplicate template group/
  );
});

test('template translation rejects corrupt unit replacement artifacts', () => {
  assert.throws(
    () => _private.parseTemplateTranslation(JSON.stringify([
      { group_id: 'template-0001', translation_merged: 'Sau mấki l? m?tngàki l? m?txuất phát.' },
    ]), chunk, 'fake', { targetLanguage: 'vi' }),
    /corrupt unit-replacement artifact/
  );
});

test('promptGroupItem calculates duration_seconds and max_words_guideline from segment timing', () => {
  const item = _private.promptGroupItem({
    group_id: 'template-0001',
    start: 5.0,
    end: 8.2,
    text: 'Some text',
  });

  assert.equal(item.group_id, 'template-0001');
  assert.equal(item.duration_seconds, 3.2);
  assert.equal(item.max_words_guideline, 8); // Math.floor(3.2 * 2.7) = 8
});
