const test = require('node:test');
const assert = require('node:assert/strict');

const { applyPlanToUnits, planTtsFit } = require('../domain/ttsFitPlanner');
const { createTtsQcReport } = require('../domain/qcReport');

test('tts fit planner keeps fitting units unchanged', () => {
  const units = [{ id: 'u1', start: 0, end: 4, text: 'Xin chao.' }];
  const plan = planTtsFit(units, { speakingRate: 1, ttsFitMode: 'balanced', ttsFitMaxRate: 1.15 });

  assert.equal(plan.status, 'ok');
  assert.equal(plan.units[0].action, 'ok');
  assert.equal(applyPlanToUnits(units, plan, {})[0].text, 'Xin chao.');
});

test('tts fit planner suggests per-unit speed for mild overflow without exceeding max rate', () => {
  const units = [{ id: 'u1', start: 0, end: 2.2, text: 'Day la mot cau hoi dai hon mot chut.' }];
  const plan = planTtsFit(units, {
    speakingRate: 1,
    ttsFitMode: 'balanced',
    ttsFitMaxRate: 1.1,
    ttsFitWordsPerSecond: 3.8,
  });

  assert.equal(plan.status, 'warn');
  assert.equal(plan.units[0].action, 'speed_up');
  assert.ok(plan.units[0].suggestedRate <= 1.1);
  assert.ok(plan.units[0].suggestedRate >= 1);
});

test('measured anti-overflow mode keeps every cue at the target rate before timeline QC', () => {
  const units = [{ id: 'u1', start: 0, end: 2.2, text: 'Day la mot cau hoi dai hon mot chut.' }];
  const plan = planTtsFit(units, {
    speakingRate: 1,
    ttsFitMode: 'balanced',
    ttsFitMaxRate: 1.05,
    ttsFitWordsPerSecond: 3.8,
    ttsFitMeasuredOverflowOnly: true,
  });

  assert.equal(plan.units[0].action, 'ok');
  assert.equal(plan.units[0].suggestedRate, 1);
  assert.match(plan.units[0].reason, /measure audio/i);
  assert.equal(applyPlanToUnits(units, plan, {})[0].suggestedRate, undefined);
});

test('tts fit planner does not shorten moderate overflow', () => {
  const units = [{ id: 'u1', start: 0, end: 3.6, text: 'Co ve nhu video ky nay den day la het, cam on 12 ban da xem.' }];
  const plan = planTtsFit(units, {
    speakingRate: 1,
    ttsFitMode: 'balanced',
    ttsFitMaxRate: 1.15,
  });
  const fitted = applyPlanToUnits(units, plan, {});

  assert.equal(plan.units[0].action, 'manual_review');
  assert.equal(plan.units[0].fittedText, plan.units[0].originalText);
  assert.equal(fitted[0].text, units[0].text);
});

test('tts fit planner accounts for selected speaking rate before review', () => {
  const units = [{
    id: 'u1',
    start: 0,
    end: 3.02,
    text: 'Mot cap doi dang lan trong mot hang dong duoi nuoc noi tieng.',
  }];
  const plan = planTtsFit(units, {
    speakingRate: 1.2,
    ttsFitMode: 'strict',
    ttsFitMaxRate: 1.2,
  });

  assert.equal(applyPlanToUnits(units, plan, {})[0].text, units[0].text);
});

test('tts fit planner keeps heavy overflow as manual review', () => {
  const units = [{
    id: 'u1',
    start: 0,
    end: 0.8,
    text: 'Day la mot cau rat dai voi qua nhieu noi dung khong the doc kip trong mot khoang thoi gian cuc ngan.',
  }];
  const plan = planTtsFit(units, { speakingRate: 1, ttsFitMode: 'balanced' });

  assert.equal(plan.status, 'error');
  assert.equal(plan.units[0].action, 'manual_review');
  assert.equal(plan.units[0].fittedText, plan.units[0].originalText);
});

test('tts fit planner defaults heavy overflow to manual review', () => {
  const units = [{
    id: 'u1',
    start: 0,
    end: 0.8,
    text: 'Day la mot cau rat dai voi qua nhieu noi dung khong the doc kip trong mot khoang thoi gian cuc ngan.',
  }];
  const plan = planTtsFit(units, { speakingRate: 1, ttsFitMode: 'balanced' });

  assert.equal(plan.status, 'error');
  assert.equal(plan.units[0].action, 'manual_review');
});

test('tts fit planner ignores removed auto shorten flag', () => {
  const units = [{
    id: 'u1',
    start: 0,
    end: 0.8,
    text: 'Day la mot cau rat dai voi qua nhieu noi dung khong the doc kip trong mot khoang thoi gian cuc ngan.',
  }];
  const plan = planTtsFit(units, { speakingRate: 1, ttsFitMode: 'balanced' });

  assert.equal(plan.status, 'error');
  assert.equal(plan.units[0].action, 'manual_review');
});

test('tts qc report includes fit plan details', () => {
  const units = [{ id: 'u1', start: 0, end: 1, text: 'Xin chao.', ttsFit: { action: 'speed_up', fitRatio: 1.1 } }];
  const fitPlan = {
    status: 'warn',
    enabled: true,
    mode: 'balanced',
    summary: { total: 1, speed_up: 1 },
    units: [{ id: 'u1', action: 'speed_up', fitRatio: 1.1, overflowBefore: 0.1 }],
  };
  const report = createTtsQcReport(units, [], { ttsFitPlan: fitPlan });

  assert.equal(report.fitPlan.status, 'warn');
  assert.equal(report.fitPlan.units[0].action, 'speed_up');
});

test('tts qc report keeps source row mapping on provider failures', () => {
  const units = [{
    id: 'tts-001',
    start: 0,
    end: 3,
    text: 'Xin chao.',
    sourceIds: ['row_1'],
    sourceRowIds: ['row_1'],
  }];
  const clips = [{
    id: 'tts-001',
    index: 0,
    ttsError: true,
    errorCode: 'TTS_FAILED',
    errorMessage: 'Missing credentials.',
    provider: 'google_cloud_tts',
  }];
  const report = createTtsQcReport(units, clips, {});

  assert.equal(report.issues[0].code, 'TTS_FAILED');
  assert.deepEqual(report.issues[0].sourceRowIds, ['row_1']);
});
