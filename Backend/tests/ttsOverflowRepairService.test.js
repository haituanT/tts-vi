const test = require('node:test');
const assert = require('node:assert/strict');

const {
  repairTtsOverflowTranslations,
  _private,
} = require('../services/ttsOverflowRepairService');

const input = [
  {
    row_id: 'row-1',
    source_text: 'The truck was stuck in the desert.',
    current_translation: 'Chiếc xe tải bị mắc kẹt giữa sa mạc mênh mông.',
    slot_seconds: 2,
    audio_seconds: 3,
  },
  {
    row_id: 'row-2',
    source_text: 'They had no way to call for help.',
    current_translation: 'Họ hoàn toàn không có cách nào để gọi người đến cứu.',
    slot_seconds: 1.8,
    audio_seconds: 2.8,
  },
];

test('normalizes repair input with overflow metrics', () => {
  const normalized = _private.normalizeRepairInput(input);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].row_id, 'row-1');
  assert.equal(normalized[0].overflow_seconds, 1);
  assert.equal(normalized[0].fit_ratio, 1.5);
  assert.equal(normalized[0].target_tts_rate, 1);
  assert.equal(Object.hasOwn(normalized[0], 'target_chars'), false);
  assert.match(normalized[0].repair_hint, /ignore overflow amounts and thresholds/);
});

test('parses valid TTS overflow repair output in input order', () => {
  const normalized = _private.normalizeRepairInput(input);
  const repairs = _private.parseRepairOutput(JSON.stringify([
    { row_id: 'row-2', repaired_translation: 'Họ không có cách nào để gọi người đến cứu.' },
    { row_id: 'row-1', repaired_translation: 'Chiếc xe mắc kẹt giữa sa mạc.' },
  ]), normalized, 'fake');
  assert.deepEqual(repairs, [
    { row_id: 'row-1', repaired_translation: 'Chiếc xe mắc kẹt giữa sa mạc.' },
    { row_id: 'row-2', repaired_translation: 'Họ không có cách nào để gọi người đến cứu.' },
  ]);
});

test('rejects missing row_id in TTS overflow repair output', () => {
  const normalized = _private.normalizeRepairInput(input.slice(0, 1));
  assert.throws(
    () => _private.parseRepairOutput(JSON.stringify([{ repaired_translation: 'Bản sửa.' }]), normalized, 'fake'),
    /unexpected TTS repair row/
  );
});

test('rejects missing repaired_translation in TTS overflow repair output', () => {
  const normalized = _private.normalizeRepairInput(input.slice(0, 1));
  assert.throws(
    () => _private.parseRepairOutput(JSON.stringify([{ row_id: 'row-1' }]), normalized, 'fake'),
    /missed TTS repair row/
  );
});

test('rejects extra or missing TTS overflow repair rows', () => {
  const normalized = _private.normalizeRepairInput(input);
  assert.throws(
    () => _private.parseRepairOutput(JSON.stringify([
      { row_id: 'row-1', repaired_translation: 'Chiếc xe mắc kẹt giữa sa mạc.' },
      { row_id: 'row-x', repaired_translation: 'Dòng thừa.' },
    ]), normalized, 'fake'),
    /unexpected TTS repair row/
  );
  assert.throws(
    () => _private.parseRepairOutput(JSON.stringify([
      { row_id: 'row-1', repaired_translation: 'Chiếc xe mắc kẹt giữa sa mạc.' },
    ]), normalized, 'fake'),
    /missed TTS repair row/
  );
});

test('rejects Chinese characters in Vietnamese TTS overflow repair output', () => {
  const normalized = _private.normalizeRepairInput(input.slice(0, 1));
  assert.throws(
    () => _private.parseRepairOutput(JSON.stringify([
      { row_id: 'row-1', repaired_translation: 'Một ngày sau, lực lượng cứu hộ廷 tới.' },
    ]), normalized, 'fake', { targetLanguage: 'vi' }),
    /Chinese Han\/Hanzi\/Kanji/
  );
});

test('rejects corrupt unit replacement artifacts in TTS overflow repair output', () => {
  const normalized = _private.normalizeRepairInput(input.slice(0, 1));
  assert.throws(
    () => _private.parseRepairOutput(JSON.stringify([
      { row_id: 'row-1', repaired_translation: 'Sau mấki l? m?tngàki l? m?txuất phát.' },
    ]), normalized, 'fake', { targetLanguage: 'vi' }),
    /corrupt unit-replacement artifact/
  );
});

test('normalizes nonessential commas in Vietnamese TTS repair output', () => {
  const normalized = _private.normalizeRepairInput([{
    ...input[0],
    current_translation: 'Dot nhien tay anh cham vao loi thong va chui ngay vao do 1,5 giay sau.',
  }]);
  const repairs = _private.parseRepairOutput(JSON.stringify([
    { row_id: 'row-1', repaired_translation: 'Dot nhien, tay anh cham vao loi thong, va chui ngay vao do, 1,5 giay sau.' },
  ]), normalized, 'fake', { targetLanguage: 'vi' });
  assert.deepEqual(repairs, [
    { row_id: 'row-1', repaired_translation: 'Dot nhien tay anh cham vao loi thong va chui ngay vao do 1,5 giay sau.' },
  ]);
});

test('accepts a shorter synonymous replacement for TTS repair', () => {
  const normalized = _private.normalizeRepairInput([{
    row_id: 'row-1',
    source_text: 'He could not move.',
    current_translation: 'Anh khong the cu dong.',
  }]);
  const repairs = _private.parseRepairOutput(JSON.stringify([
    { row_id: 'row-1', repaired_translation: 'Anh bat dong.' },
  ]), normalized, 'fake', { targetLanguage: 'vi' });
  assert.deepEqual(repairs, [
    { row_id: 'row-1', repaired_translation: 'Anh bat dong.' },
  ]);
});

test('repairTtsOverflowTranslations uses injected CLI runner', async () => {
  const repairs = await repairTtsOverflowTranslations(input.slice(0, 1), {
    translationProvider: 'codex_cli',
    sourceLanguage: 'en',
    targetLanguage: 'vi',
  }, {
    runCliTranslation: async (_provider, request) => {
      assert.ok(request.userPrompt.includes('subtitle-tts-overflow-repair'));
      assert.ok(request.userPrompt.includes('shorter synonyms'));
      assert.ok(request.userPrompt.includes('Read source_text first'));
      assert.ok(request.userPrompt.includes('Do not delete a separate fact'));
      assert.ok(request.userPrompt.includes('smallest useful edit'));
      assert.ok(request.userPrompt.includes('retranslate only the smallest long phrase'));
      assert.ok(request.userPrompt.includes('complete narration beat'));
      assert.ok(request.userPrompt.includes('Proper names are locked display text'));
      assert.ok(request.userPrompt.includes('never remove, translate, Vietnamese-ize, phoneticize'));
      assert.ok(request.userPrompt.includes('Ignore overflow seconds, fit ratio, and every timing threshold'));
      assert.ok(request.userPrompt.includes('must contain no non-numeric commas'));
      assert.ok(request.userPrompt.includes('commas as TTS pauses'));
      assert.equal(request.userPrompt.includes('target_chars'), false);
      assert.ok(request.userPrompt.includes('km -> cây số'));
      assert.ok(request.userPrompt.includes('km/h -> cây số trên giờ'));
      assert.ok(request.userPrompt.includes('km2/km² -> ki lô mét vuông'));
      assert.ok(request.userPrompt.includes('m/s -> mét trên giây'));
      assert.ok(request.userPrompt.includes('CNY/RMB/NDT/¥ -> tệ'));
      assert.ok(request.userPrompt.includes('GB -> ghi ga bai'));
      assert.ok(request.userPrompt.includes('kW -> ki lô oát'));
      assert.ok(request.userPrompt.includes('thứ 1 -> thứ nhất'));
      assert.ok(request.userPrompt.includes('Mbps -> mê ga bit trên giây'));
      assert.ok(request.userPrompt.includes('MB/s -> mê ga bai trên giây'));
      assert.ok(request.userPrompt.includes('fps -> khung hình trên giây'));
      assert.ok(request.userPrompt.includes('mmHg -> mi li mét thủy ngân'));
      assert.ok(request.userPrompt.includes('mAh -> mi li ampe giờ'));
      assert.ok(request.userPrompt.includes('AUD -> đô Úc'));
      assert.equal(/km2[^\n]*cây số vuông/u.test(request.userPrompt), false);
      assert.ok(request.userPrompt.includes('"row_id": "row-1"'));
      return JSON.stringify([
        { row_id: 'row-1', repaired_translation: 'Chiếc xe mắc kẹt giữa sa mạc.' },
      ]);
    },
  });
  assert.deepEqual(repairs, [
    { row_id: 'row-1', repaired_translation: 'Chiếc xe mắc kẹt giữa sa mạc.' },
  ]);
});
test('repairTtsOverflowTranslations batches large repair requests and preserves order', async () => {
  const manyRows = Array.from({ length: 5 }, (_, index) => ({
    row_id: `row-${index + 1}`,
    source_text: `Source ${index + 1}`,
    current_translation: `Ban dich dai ${index + 1}`,
    slot_seconds: 1,
    audio_seconds: 2,
  }));
  const calls = [];
  const repairs = await repairTtsOverflowTranslations(manyRows, {
    translationProvider: 'codex_cli',
    targetLanguage: 'vi',
    ttsOverflowRepairBatchSize: 2,
  }, {
    runCliTranslation: async (_provider, request) => {
      const marker = '\nInput:\n';
      const start = request.userPrompt.lastIndexOf(marker);
      const end = request.userPrompt.indexOf('\n\nReturn JSON array only', start);
      const payload = JSON.parse(request.userPrompt.slice(start + marker.length, end));
      calls.push(payload.map((item) => item.row_id));
      return JSON.stringify(payload.map((item) => ({
        row_id: item.row_id,
        repaired_translation: item.current_translation,
      })).reverse());
    },
  });
  assert.deepEqual(calls, [['row-1', 'row-2'], ['row-3', 'row-4'], ['row-5']]);
  assert.deepEqual(repairs.map((item) => item.row_id), ['row-1', 'row-2', 'row-3', 'row-4', 'row-5']);
});

test('repairTtsOverflowTranslations runs repair batches concurrently', async () => {
  const manyRows = Array.from({ length: 6 }, (_, index) => ({
    row_id: `row-${index + 1}`,
    current_translation: `Long translation ${index + 1}`,
  }));
  let active = 0;
  let maxActive = 0;
  const repairs = await repairTtsOverflowTranslations(manyRows, {
    translationProvider: 'codex_cli',
    targetLanguage: 'vi',
    ttsOverflowRepairBatchSize: 2,
    ttsOverflowRepairConcurrency: 3,
  }, {
    runCliTranslation: async (_provider, request) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      const marker = '\nInput:\n';
      const start = request.userPrompt.lastIndexOf(marker);
      const end = request.userPrompt.indexOf('\n\nReturn JSON array only', start);
      const payload = JSON.parse(request.userPrompt.slice(start + marker.length, end));
      return JSON.stringify(payload.map((item) => ({
        row_id: item.row_id,
        repaired_translation: item.current_translation,
      })));
    },
  });
  assert.equal(maxActive, 3);
  assert.deepEqual(repairs.map((item) => item.row_id), ['row-1', 'row-2', 'row-3', 'row-4', 'row-5', 'row-6']);
});

test('repairTtsOverflowTranslations can force one request for selected repair rows', async () => {
  const manyRows = Array.from({ length: 9 }, (_, index) => ({
    row_id: `row-${index + 1}`,
    current_translation: `Long translation ${index + 1}`,
  }));
  const calls = [];
  const repairs = await repairTtsOverflowTranslations(manyRows, {
    translationProvider: 'codex_cli',
    targetLanguage: 'vi',
    ttsOverflowRepairSingleRequest: true,
    ttsOverflowRepairConcurrency: 1,
  }, {
    runCliTranslation: async (_provider, request) => {
      const marker = '\nInput:\n';
      const start = request.userPrompt.lastIndexOf(marker);
      const end = request.userPrompt.indexOf('\n\nReturn JSON array only', start);
      const payload = JSON.parse(request.userPrompt.slice(start + marker.length, end));
      calls.push(payload.map((item) => item.row_id));
      return JSON.stringify(payload.map((item) => ({
        row_id: item.row_id,
        repaired_translation: item.current_translation,
      })));
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], manyRows.map((item) => item.row_id));
  assert.deepEqual(repairs.map((item) => item.row_id), manyRows.map((item) => item.row_id));
});
