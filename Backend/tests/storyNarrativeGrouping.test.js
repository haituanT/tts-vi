const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeStorySourceCues,
  normalizeAtoms,
  buildStorySegmentPlan,
} = require('../domain/storyTranslation');
const { buildStoryPrompt } = require('../services/storyTranslationService');

test('story planner combines adjacent independent short cues into one narration beat', () => {
  const cues = normalizeStorySourceCues([
    { start: 0, end: 2, text: 'one' },
    { start: 2, end: 4, text: 'two' },
    { start: 4, end: 6, text: 'three' },
  ]);
  const atoms = normalizeAtoms([
    { sourceRefs: ['C0001'], meaningVi: 'Ý một.' },
    { sourceRefs: ['C0002'], meaningVi: 'Ý hai.' },
    { sourceRefs: ['C0003'], meaningVi: 'Ý ba.' },
  ], cues);

  const plan = buildStorySegmentPlan(cues, atoms, {
    storyNarrativeGrouping: true,
    storyTargetMinSeconds: 4,
    storyTargetMaxSeconds: 8,
  });
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0].sourceIds, ['C0001', 'C0002']);
  assert.deepEqual(plan[1].sourceIds, ['C0003']);
});

test('story writer receives source context on both sides of its timed plans', () => {
  const prompt = buildStoryPrompt({
    cues: [{ id: 'C0002', startMs: 2000, endMs: 4000, textZh: 'main' }],
    contextBefore: [{ id: 'C0001', startMs: 0, endMs: 2000, textZh: 'before' }],
    contextAfter: [{ id: 'C0003', startMs: 4000, endMs: 6000, textZh: 'after' }],
  }, [], [], { sourceLanguage: 'zh', targetLanguage: 'vi' });

  assert.match(prompt, /whole ordered batch as one continuous/u);
  assert.match(prompt, /contextBefore/);
  assert.match(prompt, /contextAfter/);
  assert.match(prompt, /Mandatory silent process/u);
  assert.match(prompt, /true spoken filler/u);
});
