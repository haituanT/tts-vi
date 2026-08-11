const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatCliJsonEntries,
  buildCliJsonSystemPrompt,
  buildCliJsonUserPrompt,
  buildCliLineSystemPrompt,
  buildCliLineUserPrompt,
  getTimingFitStatus,
  targetTtsRateForTranslation,
  translationCompletenessRisk,
  findClippedTranslationEntries,
  parseCliJsonTranslations,
  parseCliLineTranslations,
} = require('../services/googleTranslateService');
const { createTranslationQcReport } = require('../domain/qcReport');

test('translation timing budget uses translation target rate independent from TTS rate', () => {
  const segment = { start: 0, end: 2, duration: 2, text: 'Một câu tiếng Việt khá dài để kiểm tra.' };
  const slowBudget = getTimingFitStatus(segment.text, segment, {
    targetLanguage: 'vi',
    speakingRate: 1.5,
    translationTargetTtsRate: 1,
  });
  const fastBudget = getTimingFitStatus(segment.text, segment, {
    targetLanguage: 'vi',
    speakingRate: 1,
    translationTargetTtsRate: 1.5,
  });

  assert.equal(targetTtsRateForTranslation({ translationTargetTtsRate: 2 }), 1.5);
  assert.ok(slowBudget.estimatedSeconds > fastBudget.estimatedSeconds);
  assert.equal(slowBudget.targetTtsRate, 1);
  assert.equal(fastBudget.targetTtsRate, 1.5);
});

test('CLI JSON translation input excludes timing fields that can cause clipped translations', () => {
  const payload = JSON.parse(formatCliJsonEntries([
    { index: 1, start: 1, end: 4.25, text: '他想了很久，最后决定一个人进去。' },
  ], { translationTargetTtsRate: 1.1 }));

  assert.equal(payload.length, 1);
  assert.deepEqual(Object.keys(payload[0]), ['index', 'text']);
  assert.equal(payload[0].text, '他想了很久，最后决定一个人进去。');
});

test('CLI retranslation prompts load the subtitle translation skill', () => {
  const jsonSystemPrompt = buildCliJsonSystemPrompt();
  const lineSystemPrompt = buildCliLineSystemPrompt();
  const jsonPrompt = buildCliJsonUserPrompt({
    chunkJson: JSON.stringify([{ index: 1, text: '80 km' }]),
    sourceLanguage: 'zh',
    targetLanguage: 'vi',
    expectedCueCount: 1,
  });
  const linePrompt = buildCliLineUserPrompt({
    chunkLines: '1\t80 km',
    sourceLanguage: 'zh',
    targetLanguage: 'vi',
    expectedCueCount: 1,
  });

  assert.ok(jsonSystemPrompt.includes('subtitle-translation-prompt'));
  assert.ok(lineSystemPrompt.includes('subtitle-translation-prompt'));
  assert.ok(jsonPrompt.includes('Skill: subtitle-translation-prompt'));
  assert.ok(linePrompt.includes('Skill: subtitle-translation-prompt'));
  assert.ok(jsonPrompt.includes('Han/Hanzi/Kanji'));
  assert.ok(linePrompt.includes('Han/Hanzi/Kanji'));
  assert.ok(jsonPrompt.includes('Use this skill as the single source of behavior'));
  assert.ok(linePrompt.includes('Use this skill as the single source of behavior'));
  assert.equal(jsonPrompt.includes('TRANSLATION SKILL:'), false);
  assert.equal(linePrompt.includes('TRANSLATION SKILL:'), false);
  assert.equal(jsonPrompt.includes('TRANSLATION STYLE:'), false);
  assert.equal(linePrompt.includes('TRANSLATION STYLE:'), false);
});

test('CLI translation parsers reject Chinese characters in Vietnamese output', () => {
  const input = [{ index: 1, text: '救援队到了。' }];
  assert.throws(
    () => parseCliJsonTranslations(
      JSON.stringify([{ index: 1, text: 'Lực lượng cứu hộ廷 tới.' }]),
      input,
      'fake',
      { targetLanguage: 'vi' }
    ),
    /Chinese Han\/Hanzi\/Kanji/
  );
  assert.throws(
    () => parseCliLineTranslations('1\tLực lượng cứu hộ廷 tới.', input, 'fake', { targetLanguage: 'vi' }),
    /Chinese Han\/Hanzi\/Kanji/
  );
});

test('CLI translation parsers reject corrupt unit replacement artifacts', () => {
  const input = [{ index: 1, text: '出发几天后 可能是对路况不熟悉' }];
  assert.throws(
    () => parseCliJsonTranslations(
      JSON.stringify([{ index: 1, text: 'Sau mấki l? m?tngàki l? m?txuất phát.' }]),
      input,
      'fake',
      { targetLanguage: 'vi' }
    ),
    /corrupt unit-replacement artifact/
  );
  assert.throws(
    () => parseCliLineTranslations('1\tSau mấki l? m?tngàki l? m?txuất phát.', input, 'fake', { targetLanguage: 'vi' }),
    /corrupt unit-replacement artifact/
  );
});

test('translation completeness check flags a long source reduced to a fragment', () => {
  const risk = translationCompletenessRisk(
    '他们在沙漠里走了很多天，因为卡车坏了，所以剩下的水已经不多了',
    'Họ đi trong sa mạc.',
    { sourceLanguage: 'zh', targetLanguage: 'vi' }
  );

  assert.ok(risk);
  assert.ok(risk.translatedWords < risk.minimumWords);
});

test('translation completeness check accepts a concise but complete Vietnamese sentence', () => {
  const source = [{ index: 7, text: '他们在沙漠里走了很多天，因为卡车坏了，所以剩下的水已经不多了' }];
  const translated = [{ index: 7, text: 'Họ đã đi nhiều ngày trong sa mạc; vì xe tải bị hỏng nên lượng nước còn lại không còn bao nhiêu.' }];

  assert.deepEqual(findClippedTranslationEntries(source, translated, {
    sourceLanguage: 'zh',
    targetLanguage: 'vi',
  }), []);
});

test('translation QC warns on target TTS timing overflow without failing', () => {
  const report = createTranslationQcReport(
    [{ id: 's1', start: 0, end: 2, text: '他想了很久。' }],
    [{
      id: 'meaning-001',
      start: 0,
      end: 2,
      text: 'Sau khi suy nghĩ rất lâu, cuối cùng anh ấy quyết định tiếp tục đi vào bên trong.',
      ttsTimingFit: {
        status: 'too_long',
        estimatedSeconds: 3.8,
        slotSeconds: 2,
        targetTtsRate: 1,
        validation: 'estimate',
      },
    }],
    {}
  );

  assert.equal(report.status, 'warn');
  assert.ok(report.issues.some((issue) => issue.code === 'TRANSLATION_TTS_TIMING'));
});
