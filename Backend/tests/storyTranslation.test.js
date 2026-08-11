const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeStorySourceCues,
  buildStoryWindows,
  normalizeAtoms,
  normalizeOmissions,
  buildStorySegmentPlan,
  normalizeStorySegments,
  normalizePlannedStorySegments,
  validateAtomLedger,
  validateStoryResult,
  clampStoryTimeline,
  adaptLegacyTranslationArtifact,
} = require('../domain/storyTranslation');
const {
  buildStoryPrompt,
  buildVerifyPrompt,
  STORY_SYSTEM_PROMPT,
  VERIFY_SYSTEM_PROMPT,
  translateStorySegments,
  retranslateStorySegment,
} = require('../services/storyTranslationService');
const { resolveGoogleCloudConfig } = require('../services/configService');

function sources() {
  return [
    { id: 'old-a', start: 0, end: 3, text: '卡车坏在沙漠里。' },
    { id: 'old-b', start: 3, end: 6, text: '四周一个人也没有。' },
    { id: 'old-c', start: 6, end: 9, text: '请点赞关注。' },
  ];
}

test('story v2 and story TTS units are the default translation contract', () => {
  const config = resolveGoogleCloudConfig({
    googleCloudConfig: { sourceLanguage: 'zh', targetLanguage: 'vi', translationProvider: 'codex_cli' },
  });
  assert.equal(config.translationMode, 'story_v2');
  assert.equal(config.ttsUnitMode, 'story_segments');
  assert.equal(config.storyBoundaryMaxShiftSeconds, 0.35);
  assert.equal(config.storyAbsoluteMaxSegmentSeconds, 10);
  assert.equal(config.ttsFitMaxRate, 1);
});

test('source cue IDs are stable and preserve original IDs and timing', () => {
  const first = normalizeStorySourceCues(sources());
  const second = normalizeStorySourceCues(sources());
  assert.deepEqual(first.map((cue) => cue.id), ['C0001', 'C0002', 'C0003']);
  assert.deepEqual(first.map((cue) => cue.id), second.map((cue) => cue.id));
  assert.equal(first[0].originalId, 'old-a');
  assert.equal(first[1].startMs, 3000);
});

test('context windows are technical context, not fixed cue groups', () => {
  const cues = normalizeStorySourceCues([
    { start: 0, end: 8, text: '一。' },
    { start: 8, end: 16, text: '二。' },
    { start: 16, end: 24, text: '三。' },
    { start: 26, end: 29, text: '四。' },
  ]);
  const windows = buildStoryWindows(cues, { storyContextTargetSeconds: 20, storyContextMaxSeconds: 30, storyHardBreakGapSeconds: 1.2 });
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0].cues.map((cue) => cue.id), ['C0001', 'C0002', 'C0003']);
  assert.deepEqual(windows[1].contextBefore.map((cue) => cue.id), ['C0002', 'C0003']);
});

test('context windows do not end on a dangling Chinese connector', () => {
  const cues = normalizeStorySourceCues([
    { start: 0, end: 10, text: '\u7b2c\u4e00\u6bb5\u3002' },
    { start: 10, end: 20, text: '\u7b2c\u4e8c\u6bb5\u3002' },
    { start: 20, end: 29.8, text: '\u4f46\u662f' },
    { start: 29.8, end: 31, text: '\u6c99\u6f20\u4e2d\u6240\u8c13\u7684\u8def' },
  ]);
  const windows = buildStoryWindows(cues, { storyContextTargetSeconds: 25, storyContextMaxSeconds: 30, storyHardBreakGapSeconds: 1.2 });
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0].cues.map((cue) => cue.id), ['C0001', 'C0002']);
  assert.deepEqual(windows[1].cues.map((cue) => cue.id), ['C0003', 'C0004']);
});

test('word timestamps create stable sub-anchors only at hard sentence punctuation', () => {
  const cues = normalizeStorySourceCues([{
    id: 'source-10',
    start: 0,
    end: 4,
    text: '卡车坏了。四周无人。',
    words: [
      { text: '卡车', start: 0, end: 0.8 },
      { text: '坏了。', start: 0.8, end: 1.8 },
      { text: '四周', start: 2, end: 2.8 },
      { text: '无人。', start: 2.8, end: 4 },
    ],
  }]);
  assert.deepEqual(cues.map((cue) => cue.id), ['C0001-A', 'C0001-B']);
  assert.equal(cues[0].originalId, 'source-10');
  assert.equal(cues[1].startMs, 2000);
});

test('atom and story validators reject missing and duplicate coverage without duration-only failures', () => {
  const cues = normalizeStorySourceCues(sources());
  const atoms = normalizeAtoms([
    { sourceRefs: ['C0001'], meaningVi: 'Xe tải hỏng.', facts: ['xe tải hỏng'] },
    { sourceRefs: ['C0002'], meaningVi: 'Không có ai.', facts: ['không có người'] },
    { sourceRefs: ['C0003'], meaningVi: 'Kêu gọi theo dõi.', facts: ['quảng bá'] },
  ], cues);
  assert.equal(validateAtomLedger(cues, atoms).valid, true);
  const storySegments = normalizeStorySegments([
    { atomIds: [atoms[0].atomId, atoms[1].atomId], text: 'Chiếc xe tải hỏng giữa sa mạc, xung quanh không một bóng người.' },
  ], atoms, cues);
  const sourceById = new Map(cues.map((cue) => [cue.id, cue]));
  const atomById = new Map(atoms.map((atom) => [atom.atomId, atom]));
  const omissions = normalizeOmissions([
    { atomIds: [atoms[2].atomId], reason: 'omitted_branding' },
  ], atomById, sourceById);
  const storyText = storySegments.map((segment) => segment.text).join(' ');
  const valid = validateStoryResult({ sourceCues: cues, atoms, storyText, storySegments, omissions });
  assert.equal(valid.valid, true);

  const duplicate = validateStoryResult({
    sourceCues: cues,
    atoms,
    storyText,
    storySegments,
    omissions: [...omissions, { ...omissions[0] }],
  });
  assert.ok(duplicate.errors.some((error) => error.startsWith('duplicate_atom_coverage')));

  const overlongCues = normalizeStorySourceCues([{ start: 0, end: 12, text: '很长的一句话。' }]);
  const overlongAtoms = normalizeAtoms([{ sourceRefs: ['C0001'], meaningVi: 'Một câu rất dài.' }], overlongCues);
  const overlongSegments = normalizeStorySegments([{ atomIds: [overlongAtoms[0].atomId], text: 'Một câu rất dài.' }], overlongAtoms, overlongCues);
  const overlong = validateStoryResult({
    sourceCues: overlongCues,
    atoms: overlongAtoms,
    storyText: 'Một câu rất dài.',
    storySegments: overlongSegments,
    omissions: [],
  });
  assert.equal(overlong.valid, true);
});

test('normalizers assign contiguous IDs only after invalid model rows are filtered', () => {
  const cues = normalizeStorySourceCues(sources());
  const atoms = normalizeAtoms([
    { sourceRefs: ['C0001'], meaningVi: 'Ý thứ nhất.' },
    { sourceRefs: [], meaningVi: 'Dòng lỗi phải bị lọc.' },
    { sourceRefs: ['C0002'], meaningVi: 'Ý thứ hai.' },
  ], cues, 10);
  assert.deepEqual(atoms.map((atom) => atom.atomId), ['A00011', 'A00012']);

  const nextAtoms = normalizeAtoms([
    { sourceRefs: ['C0003'], meaningVi: 'Ý ở cửa sổ kế tiếp.' },
  ], cues, 10 + atoms.length);
  assert.deepEqual(nextAtoms.map((atom) => atom.atomId), ['A00013']);

  const segments = normalizeStorySegments([
    { atomIds: [], text: 'Dòng lỗi phải bị lọc.' },
    { atomIds: ['A00011'], text: 'Ý thứ nhất.' },
  ], atoms, cues, 7);
  assert.deepEqual(segments.map((segment) => segment.segmentId), ['V00008']);
});

test('atom ledger keeps map validation separate from duration review', () => {
  const cues = normalizeStorySourceCues([
    { start: 0, end: 6, text: '第一部分。' },
    { start: 6, end: 12, text: '第二部分。' },
  ]);
  const atoms = normalizeAtoms([
    { sourceRefs: ['C0001', 'C0002'], meaningVi: 'Hai ý bị gom quá dài.' },
  ], cues);
  assert.equal(validateAtomLedger(cues, atoms, { storyAbsoluteMaxSegmentSeconds: 10 }).valid, true);
});

test('segment planner keeps dependent atoms together and exposes meaning text', () => {
  const cues = normalizeStorySourceCues([
    { start: 0, end: 2, text: 'fuel' },
    { start: 2, end: 4, text: 'water and food' },
    { start: 4, end: 6, text: 'overload' },
  ]);
  const atoms = normalizeAtoms([
    { sourceRefs: ['C0001'], meaningVi: 'Xe cho nhien lieu.', facts: ['nhien lieu'], dependsOnNext: true },
    { sourceRefs: ['C0002'], meaningVi: 'Xe cho thung nuoc va thuc an.', facts: ['thung nuoc', 'thuc an'], dependsOnNext: true },
    { sourceRefs: ['C0003'], meaningVi: 'Xe vuot tai thiet ke.', facts: ['vuot tai thiet ke'], dependsOnPrevious: true },
  ], cues);
  const plan = buildStorySegmentPlan(cues, atoms);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].sourceIds, ['C0001', 'C0002', 'C0003']);
  assert.deepEqual(plan[0].atomIds, ['A00001', 'A00002', 'A00003']);
  assert.ok(plan[0].meaningText.includes('vuot tai thiet ke'));
});

test('planned story normalizer trusts plan ids instead of model supplied mapping', () => {
  const cues = normalizeStorySourceCues(sources());
  const atoms = normalizeAtoms([
    { sourceRefs: ['C0001'], meaningVi: 'Xe hong.', facts: ['xe hong'] },
    { sourceRefs: ['C0002'], meaningVi: 'Khong co ai.', facts: ['khong co ai'] },
  ], cues);
  const plan = buildStorySegmentPlan(cues, atoms);
  const storySegments = normalizePlannedStorySegments([
    { planId: 'P00001', sourceIds: ['C0003'], atomIds: ['A99999'], text: 'Xe hong.' },
    { planId: 'P00002', text: 'Khong co ai.' },
  ], plan, cues);
  assert.deepEqual(storySegments.map((segment) => segment.sourceIds), [['C0001'], ['C0002']]);
  assert.deepEqual(storySegments.map((segment) => segment.atomIds), [['A00001'], ['A00002']]);
});

test('timeline clamping removes small overlap without shifting more than 350 ms', () => {
  const clamped = clampStoryTimeline([
    { id: 'V1', start: 0, end: 5.2, duration: 5.2 },
    { id: 'V2', start: 5, end: 9, duration: 4 },
  ], { storyBoundaryMaxShiftSeconds: 0.35 });
  assert.ok(clamped[0].end <= clamped[1].start);
  assert.ok(Math.abs(clamped[0].end - 5.2) <= 0.35);
  assert.ok(Math.abs(clamped[1].start - 5) <= 0.35);
});

test('story validation accepts verbalized Vietnamese numbers and rejects a lost number', () => {
  const cues = normalizeStorySourceCues([{ start: 0, end: 5, text: '车上有52个人。' }]);
  const atoms = normalizeAtoms([{ sourceRefs: ['C0001'], meaningVi: 'Trên xe có 52 người.', facts: ['52 người'] }], cues);
  const kept = normalizeStorySegments([{ atomIds: ['A00001'], text: 'Trên xe có năm mươi hai người.' }], atoms, cues);
  assert.equal(validateStoryResult({ sourceCues: cues, atoms, storyText: kept[0].text, storySegments: kept, omissions: [] }).valid, true);
  const lost = normalizeStorySegments([{ atomIds: ['A00001'], text: 'Trên xe có rất nhiều người.' }], atoms, cues);
  assert.ok(validateStoryResult({ sourceCues: cues, atoms, storyText: lost[0].text, storySegments: lost, omissions: [] }).errors.includes('missing_number:52'));
});

test('story verifier prompt includes discourse continuity checks', () => {
  const cues = normalizeStorySourceCues([
    { start: 0, end: 2, text: 'Xe há»ng.' },
    { start: 2, end: 4, text: 'KhÃ´ng cÃ³ sÃ³ng.' },
  ]);
  const atoms = normalizeAtoms([
    { sourceRefs: ['C0001'], meaningVi: 'Xe há»ng.', facts: ['xe há»ng'] },
    { sourceRefs: ['C0002'], meaningVi: 'KhÃ´ng cÃ³ sÃ³ng.', facts: ['khÃ´ng cÃ³ sÃ³ng'] },
  ], cues);
  const prompt = buildVerifyPrompt({
    cues,
    contextBefore: [],
    contextAfter: [],
  }, atoms, {
    storyText: 'Xe há»ng. KhÃ´ng cÃ³ sÃ³ng.',
    segmentPlan: [],
    storySegments: normalizeStorySegments([
      { atomIds: ['A00001'], text: 'Xe há»ng.' },
      { atomIds: ['A00002'], text: 'KhÃ´ng cÃ³ sÃ³ng.' },
    ], atoms, cues),
    omissions: [],
  });

  assert.ok(VERIFY_SYSTEM_PROMPT.includes('discourse-continuity failures'));
  assert.ok(VERIFY_SYSTEM_PROMPT.includes('isolated captions'));
  assert.ok(prompt.includes('continuityChecklist'));
  assert.ok(prompt.includes('source-supported time, cause/result, contrast'));
  assert.ok(prompt.includes('unrelated captions'));
});

test('story prompt and validation reject Han characters in Vietnamese narration', () => {
  const prompt = buildStoryPrompt({ cues: [] }, [], [], { targetLanguage: 'vi' });
  assert.ok(prompt.includes('Skill: subtitle-translation-prompt'));
  assert.ok(prompt.includes('Return this shape:'));
  assert.ok(STORY_SYSTEM_PROMPT.includes('subtitle-translation-prompt'));
  assert.ok(STORY_SYSTEM_PROMPT.includes('Han/Hanzi/Kanji'));

  const sourceCues = normalizeStorySourceCues([{ start: 0, end: 2, text: '救援队到了。' }]);
  const atoms = normalizeAtoms([{ sourceRefs: ['C0001'], meaningVi: 'Lực lượng cứu hộ tới.', facts: ['cứu hộ tới'] }], sourceCues);
  const storySegments = normalizeStorySegments([{ atomIds: ['A00001'], text: 'Lực lượng cứu hộ廷 tới.' }], atoms, sourceCues);
  const report = validateStoryResult({
    sourceCues,
    atoms,
    storyText: storySegments.map((segment) => segment.text).join(' '),
    storySegments,
  }, { targetLanguage: 'vi' });

  assert.ok(report.errors.some((error) => error.startsWith('cjk_in_vietnamese_segment')));
});

test('story validation treats dense mapped text as review warning, not mapping failure', () => {
  const cues = normalizeStorySourceCues([{ start: 0, end: 1, text: 'dense' }]);
  const atoms = normalizeAtoms([{ sourceRefs: ['C0001'], meaningVi: 'Dense fact.', facts: ['dense fact'] }], cues);
  const storySegments = normalizeStorySegments([{
    atomIds: ['A00001'],
    text: 'Mot cum dich hoi dai nhung van dung map.',
  }], atoms, cues);
  const report = validateStoryResult({
    sourceCues: cues,
    atoms,
    storyText: storySegments[0].text,
    storySegments,
    omissions: [],
  }, { translationCharsPerSecond: 13 });
  assert.equal(report.valid, true);
  assert.ok(report.warnings.some((warning) => warning.startsWith('timeline_text_too_dense:V00001')));
});

test('story translation repairs missing planned segments and keeps writer from changing maps', async () => {
  let storyCalls = 0;
  const fakeRunner = async (_provider, request) => {
    if (request.userPrompt.includes('Return this shape:\n{"meaningAtoms"')) {
      return JSON.stringify({
        meaningAtoms: [
          { sourceRefs: ['C0001'], meaningVi: 'Chiếc xe tải bị hỏng giữa sa mạc.', facts: ['xe tải bị hỏng'] },
          { sourceRefs: ['C0002'], meaningVi: 'Xung quanh không có một bóng người.', facts: ['không có người'] },
          { sourceRefs: ['C0003'], meaningVi: 'Lời kêu gọi người xem theo dõi kênh.', facts: ['quảng bá kênh'] },
        ],
      });
    }
    if (request.userPrompt.includes('Return this shape:\n{"storySegments"')) {
      storyCalls += 1;
      if (storyCalls === 1) {
        return JSON.stringify({
          storySegments: [{ planId: 'P00001', sourceIds: ['C9999'], atomIds: ['A99999'], text: 'Chiếc xe tải bị hỏng giữa sa mạc.' }],
        });
      }
      return JSON.stringify({
        storySegments: [
          { planId: 'P00001', text: 'Chiếc xe tải bị hỏng giữa sa mạc.' },
          { planId: 'P00002', text: 'Xung quanh không một bóng người.' },
          { planId: 'P00003', text: 'Lời kêu gọi người xem theo dõi kênh.' },
        ],
      });
    }
    return JSON.stringify({ valid: true, errors: [] });
  };

  const result = await translateStorySegments(sources(), {
    sourceLanguage: 'zh',
    targetLanguage: 'vi',
    translationProvider: 'codex_cli',
  }, { runCliTranslation: fakeRunner });

  assert.equal(result.schemaVersion, 'story_translation_v2');
  assert.equal(result.validation.status, 'verified');
  assert.equal(result.storySegments.length, 3);
  assert.equal(result.omissions.length, 0);
  assert.equal(storyCalls, 2);
  assert.deepEqual(result.segments[1].sourceIds, ['C0002']);
  assert.deepEqual(result.storySegments[0].atomIds, ['A00001']);
  assert.equal(result.segmentPlan.length, 3);
});

test('story translation repairs bilingual meaning omissions inside a locked plan', async () => {
  let storyCalls = 0;
  let verifyCalls = 0;
  const fakeRunner = async (_provider, request) => {
    if (request.userPrompt.includes('Return this shape:\n{"meaningAtoms"')) {
      return JSON.stringify({
        meaningAtoms: [{
          sourceRefs: ['C0001'],
          meaningVi: 'Xe cho nhien lieu, thung nuoc va thuc an nen vuot tai thiet ke.',
        }],
      });
    }
    if (request.userPrompt.includes('Return this shape:\n{"storySegments"')) {
      storyCalls += 1;
      return JSON.stringify({
        storySegments: [{
          planId: 'P00001',
          text: storyCalls === 1
            ? 'Chiec xe qua tai roi hong giua sa mac.'
            : 'Chiec xe cho nhien lieu, thung nuoc va thuc an, khien no vuot tai thiet ke roi hong giua sa mac.',
        }],
      });
    }
    verifyCalls += 1;
    const verifiedText = JSON.parse(request.userPrompt).storySegments[0].text;
    const valid = verifiedText.includes('nhien lieu')
      && verifiedText.includes('thung nuoc')
      && verifiedText.includes('thuc an')
      && verifiedText.includes('vuot tai thiet ke');
    return JSON.stringify({
      valid,
      errors: valid ? [] : ['P00001 omits meaning: nhien lieu, thung nuoc, thuc an, vuot tai thiet ke'],
    });
  };

  const result = await translateStorySegments([{ start: 0, end: 8, text: 'overloaded truck' }], {
    sourceLanguage: 'zh',
    targetLanguage: 'vi',
    translationProvider: 'codex_cli',
  }, { runCliTranslation: fakeRunner });

  assert.equal(result.validation.valid, true);
  assert.equal(storyCalls, 2);
  assert.equal(verifyCalls, 2);
  assert.ok(result.storySegments[0].text.includes('nhien lieu'));
  assert.deepEqual(result.storySegments[0].sourceIds, ['C0001']);
});

test('story verifier timeout keeps deterministic translation usable with a warning', async () => {
  const fakeRunner = async (_provider, request) => {
    if (request.userPrompt.includes('Return this shape:\n{"meaningAtoms"')) {
      return JSON.stringify({
        meaningAtoms: [{ sourceRefs: ['C0001'], meaningVi: 'Xe hỏng giữa sa mạc.', facts: [] }],
      });
    }
    if (request.userPrompt.includes('Return this shape:\n{"storySegments"')) {
      return JSON.stringify({
        storySegments: [{ planId: 'P00001', text: 'Xe hỏng giữa sa mạc.' }],
      });
    }
    throw new Error('CLI timed out after 300s.');
  };

  const result = await translateStorySegments(sources().slice(0, 1), {
    sourceLanguage: 'zh',
    targetLanguage: 'vi',
    translationProvider: 'codex_cli',
  }, { runCliTranslation: fakeRunner });

  assert.equal(result.validation.valid, true);
  assert.equal(result.validation.status, 'verified_with_warnings');
  assert.equal(result.validation.errors.length, 0);
  assert.ok(result.validation.warnings.some((warning) => warning.includes('verifier_timeout')));
  assert.equal(result.validation.windows[0].bilingualVerified, false);
});

test('story translation runs independent windows concurrently and preserves ordered IDs', async () => {
  const cues = normalizeStorySourceCues([
    { start: 0, end: 1, text: '\u7b2c\u4e00\u53e5\u3002' },
    { start: 3, end: 4, text: '\u7b2c\u4e8c\u53e5\u3002' },
    { start: 6, end: 7, text: '\u7b2c\u4e09\u53e5\u3002' },
  ]);
  let active = 0;
  let maxActive = 0;
  const fakeRunner = async (_provider, request) => {
    const sourceId = request.userPrompt.match(/"(?:mainCues|sourceCues)": \[\s*\{\s*"id": "(C\d+)"/s)?.[1] || 'C0001';
    if (request.userPrompt.includes('Return this shape:\n{"meaningAtoms"')) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return JSON.stringify({
        meaningAtoms: [{ sourceRefs: [sourceId], meaningVi: `Y ${sourceId}.`, facts: [] }],
      });
    }
    if (request.userPrompt.includes('Return this shape:\n{"storySegments"')) {
      return JSON.stringify({
        storySegments: [{ planId: 'P00001', text: `Cau ${sourceId}.` }],
      });
    }
    return JSON.stringify({ valid: true, errors: [] });
  };

  const result = await translateStorySegments(cues, {
    sourceLanguage: 'zh',
    targetLanguage: 'vi',
    translationProvider: 'codex_cli',
    cliTranslationConcurrency: 3,
    storyVerifierEnabled: false,
  }, { runCliTranslation: fakeRunner });

  assert.ok(maxActive > 1);
  assert.deepEqual(result.meaningAtoms.map((atom) => atom.atomId), ['A00001', 'A00002', 'A00003']);
  assert.deepEqual(result.storySegments.map((segment) => segment.segmentId), ['V00001', 'V00002', 'V00003']);
  assert.deepEqual(result.storySegments.map((segment) => segment.sourceIds[0]), ['C0001', 'C0002', 'C0003']);
});

test('story translation runs story writer calls concurrently across windows', async () => {
  const cues = normalizeStorySourceCues([
    { start: 0, end: 1, text: 'first.' },
    { start: 3, end: 4, text: 'second.' },
    { start: 6, end: 7, text: 'third.' },
  ]);
  let activeStory = 0;
  let maxActiveStory = 0;
  const fakeRunner = async (_provider, request) => {
    const sourceId = request.userPrompt.match(/"(?:mainCues|sourceCues)": \[\s*\{\s*"id": "(C\d+)"/s)?.[1] || 'C0001';
    if (request.userPrompt.includes('Return this shape:\n{"meaningAtoms"')) {
      return JSON.stringify({
        meaningAtoms: [{ sourceRefs: [sourceId], meaningVi: `Y ${sourceId}.`, facts: [] }],
      });
    }
    if (request.userPrompt.includes('Return this shape:\n{"storySegments"')) {
      activeStory += 1;
      maxActiveStory = Math.max(maxActiveStory, activeStory);
      await new Promise((resolve) => setTimeout(resolve, 30));
      activeStory -= 1;
      return JSON.stringify({
        storySegments: [{ planId: 'P00001', text: `Cau ${sourceId}.` }],
      });
    }
    return JSON.stringify({ valid: true, errors: [] });
  };

  const result = await translateStorySegments(cues, {
    sourceLanguage: 'zh',
    targetLanguage: 'vi',
    translationProvider: 'codex_cli',
    cliTranslationConcurrency: 3,
    storyVerifierEnabled: false,
  }, { runCliTranslation: fakeRunner });

  assert.ok(maxActiveStory > 1);
  assert.equal(result.validation.valid, true);
});

test('story resume reuses only previously verified windows and renumbers them safely', async () => {
  const sourceCues = normalizeStorySourceCues([
    { start: 0, end: 3, text: '第一句。' },
    { start: 5, end: 8, text: '第二句。' },
  ]);
  const artifact = {
    schemaVersion: 'story_translation_v2',
    sourceCues,
    meaningAtoms: [
      { atomId: 'A00003', sourceRefs: ['C0001'], meaningVi: 'Câu thứ nhất.', facts: [] },
      { atomId: 'A00003', sourceRefs: ['C0002'], meaningVi: 'Câu thứ hai.', facts: [] },
    ],
    storySegments: [
      { segmentId: 'V00001', atomIds: ['A00003'], sourceIds: ['C0001'], text: 'Câu thứ nhất.' },
      { segmentId: 'V00002', atomIds: ['A00003'], sourceIds: ['C0002'], text: 'Câu thứ hai.' },
    ],
    omissions: [],
    validation: {
      windows: [
        { windowId: 'W001', valid: true, bilingualVerified: true },
        { windowId: 'W002', valid: true, bilingualVerified: true },
      ],
    },
  };
  let calls = 0;
  const result = await translateStorySegments(sourceCues, {
    sourceLanguage: 'zh',
    targetLanguage: 'vi',
    translationProvider: 'codex_cli',
    storyHardBreakGapSeconds: 1.2,
    storyReuseArtifact: artifact,
  }, {
    runCliTranslation: async () => {
      calls += 1;
      throw new Error('Verified windows should not call the model.');
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.validation.valid, true);
  assert.deepEqual(result.meaningAtoms.map((atom) => atom.atomId), ['A00001', 'A00002']);
  assert.deepEqual(result.storySegments.map((segment) => segment.segmentId), ['V00001', 'V00002']);
  assert.ok(result.validation.windows.every((report) => report.reused === true));
});

test('unrepairable atom mapping returns a needs-review artifact and no TTS-ready segments', async () => {
  let calls = 0;
  const result = await translateStorySegments(sources().slice(0, 1), {
    sourceLanguage: 'zh',
    targetLanguage: 'vi',
    translationProvider: 'codex_cli',
    storyRepairMaxAttempts: 2,
  }, {
    runCliTranslation: async () => {
      calls += 1;
      return '{"meaningAtoms":[]}';
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.validation.status, 'needs_review');
  assert.equal(result.storySegments.length, 0);
  assert.equal(result.meaningAtoms[0].uncertain, true);
});

test('legacy artifacts remain readable but are never marked verified', () => {
  const adapted = adaptLegacyTranslationArtifact({
    sourceSegments: [{ id: 's1', start: 0, end: 2, text: '原文' }],
    segments: [{ id: 's1', start: 0, end: 2, text: 'Bản dịch cũ.' }],
  });
  assert.equal(adapted.schemaVersion, 'story_translation_v2');
  assert.equal(adapted.translationMode, 'legacy');
  assert.equal(adapted.storySegments[0].status, 'legacy_unverified');
  assert.equal(adapted.validation.valid, false);
});

test('retranslating one story segment keeps neighboring atom mappings unchanged', async () => {
  const artifact = {
    schemaVersion: 'story_translation_v2',
    translationMode: 'story_v2',
    sourceCues: normalizeStorySourceCues(sources()),
    meaningAtoms: [
      { atomId: 'A00001', sourceRefs: ['C0001'], meaningVi: 'Xe tải hỏng.', facts: [], dependsOnPrevious: false },
      { atomId: 'A00002', sourceRefs: ['C0002'], meaningVi: 'Không có người.', facts: [], dependsOnPrevious: false },
      { atomId: 'A00003', sourceRefs: ['C0003'], meaningVi: 'Quảng bá.', facts: [], dependsOnPrevious: false },
    ],
    storySegments: [
      { segmentId: 'V00001', id: 'V00001', atomIds: ['A00001'], sourceIds: ['C0001'], text: 'Xe tải hỏng.', start: 0, end: 3, duration: 3 },
      { segmentId: 'V00002', id: 'V00002', atomIds: ['A00002'], sourceIds: ['C0002'], text: 'Xung quanh không có người.', start: 3, end: 6, duration: 3 },
    ],
    omissions: [{ atomIds: ['A00003'], sourceIds: ['C0003'], reason: 'omitted_branding', sourceText: '请点赞关注。' }],
  };
  const fakeRunner = async (_provider, request) => {
    if (request.userPrompt.includes('Return this shape:\n{"storySegments"')) {
      return JSON.stringify({
        storySegments: [{ planId: 'P00001', text: 'Chiếc xe tải đã hỏng giữa sa mạc.' }],
      });
    }
    return JSON.stringify({ valid: true, errors: [] });
  };
  const updated = await retranslateStorySegment(artifact, 'V00001', {
    sourceLanguage: 'zh',
    targetLanguage: 'vi',
    translationProvider: 'codex_cli',
  }, { runCliTranslation: fakeRunner });
  assert.equal(updated.validation.valid, true);
  assert.equal(updated.storySegments[0].segmentId, 'V00001');
  assert.deepEqual(updated.storySegments[1].atomIds, ['A00002']);
  assert.equal(updated.omissions[0].reason, 'omitted_branding');
});
