const test = require('node:test');
const assert = require('node:assert/strict');

const {
  alignTranslatedUnitsById,
  assertSourceCoverage,
  buildSourceTimeline,
  buildTranslationUnits,
  buildTtsUnits,
  mapTranslatedUnitsToMergedDisplayRows,
  mapTranslatedUnitsToDisplayRows,
  validateSourceCoverage,
  validateTimelineArtifacts,
} = require('../domain/timelinePipeline');
const {
  createReadabilityQcReport,
  createTimelineQcReport,
  createTranslationQcReport,
  createTtsQcReport,
} = require('../domain/qcReport');
const {
  redistributeTranslatedPackets,
  splitLongTranslatedDisplaySegments,
} = require('../services/timelineService');

test('timeline pipeline builds source, translation, display, and tts artifacts', () => {
  const rawSegments = [
    { id: 's1', start: 0, end: 1.4, text: 'He entered the cave' },
    { id: 's2', start: 1.4, end: 3.2, text: 'without telling anyone.' },
    { id: 's3', start: 3.4, end: 5.2, text: 'The water rose suddenly.' },
  ];
  const config = {
    timelinePipelineMode: 'meaning_units',
    meaningUnitMergeGapSeconds: 0.35,
    maxMeaningUnitDuration: 5,
  };

  const source = buildSourceTimeline(rawSegments, config);
  assert.equal(source.qcReport.status, 'ok');
  assert.equal(source.sourceSegments.length, 3);

  const units = buildTranslationUnits(source.sourceSegments, config);
  assert.equal(units.mode, 'meaning_units');
  assert.ok(units.translationUnits.length >= 1);
  assert.ok(units.translationUnits.every((unit) => Array.isArray(unit.sourceRowIds)));

  const translatedUnits = units.translationUnits.map((unit, index) => ({
    ...unit,
    text: index === 0 ? 'Anh ta lang le vao hang mot minh.' : 'Nuoc bat ngo dang len.',
    translatedText: index === 0 ? 'Anh ta lang le vao hang mot minh.' : 'Nuoc bat ngo dang len.',
    finalText: index === 0 ? 'Anh ta lang le vao hang mot minh.' : 'Nuoc bat ngo dang len.',
  }));
  const display = mapTranslatedUnitsToDisplayRows(translatedUnits, source.sourceSegments, config);
  assert.equal(display.mode, 'meaning_units');
  assert.ok(display.displayRows.length >= source.sourceSegments.length);
  assert.equal(display.qcReport.errorCount, 0);

  const tts = buildTtsUnits(display.displayRows, translatedUnits, config);
  assert.ok(tts.ttsUnits.length > 0);
  assert.equal(tts.qcReport.errorCount, 0);

  const reports = validateTimelineArtifacts({
    sourceSegments: source.sourceSegments,
    translationUnits: units.translationUnits,
    displayRows: display.displayRows,
    ttsUnits: tts.ttsUnits,
  }, config);
  assert.equal(reports.source.errorCount, 0);
  assert.equal(reports.displayRows.errorCount, 0);
});

test('source coverage accepts complete ordered grouping', () => {
  const source = [
    { id: 'groq-1-1', start: 0, end: 1, text: 'A' },
    { id: 'groq-1-2', start: 1, end: 2, text: 'B' },
    { id: 'groq-1-3', start: 2, end: 3, text: 'C' },
  ];
  const groups = [
    { id: 'meaning-001', sourceRowIds: ['groq-1-1', 'groq-1-2'] },
    { id: 'meaning-002', sourceRowIds: ['groq-1-3'] },
  ];

  const report = assertSourceCoverage(source, groups);
  assert.equal(report.valid, true);
  assert.equal(report.coveragePercent, 100);
  assert.deepEqual(report.missingIds, []);
  assert.deepEqual(report.duplicateIds, []);
  assert.equal(report.orderValid, true);
});

test('source coverage rejects missing, duplicated, or reordered source ids', () => {
  const source = [
    { id: 'groq-1-1', text: 'A' },
    { id: 'groq-1-2', text: 'B' },
    { id: 'groq-1-3', text: 'C' },
  ];
  const report = validateSourceCoverage(source, [
    { id: 'meaning-001', sourceRowIds: ['groq-1-2', 'groq-1-1'] },
    { id: 'meaning-002', sourceRowIds: ['groq-1-2'] },
  ]);

  assert.equal(report.valid, false);
  assert.deepEqual(report.missingIds, ['groq-1-3']);
  assert.deepEqual(report.duplicateIds, ['groq-1-2']);
  assert.equal(report.orderValid, false);
  assert.throws(
    () => assertSourceCoverage(source, [
      { id: 'meaning-001', sourceRowIds: ['groq-1-2', 'groq-1-1'] },
      { id: 'meaning-002', sourceRowIds: ['groq-1-2'] },
    ]),
    /Phân cụm nguồn không an toàn/
  );
});

test('meaning translation units trim repeated source overlap without losing coverage', () => {
  const source = [
    {
      id: 's1',
      start: 159.1,
      end: 164.616,
      text: 'They were near the border, still 80 km from Assamaka with several water barrels',
    },
    {
      id: 's2',
      start: 164.616,
      end: 170.32,
      text: 'still 80 km from Assamaka with several water barrels after days on the road most water was gone',
    },
  ];

  const units = buildTranslationUnits(source, {
    timelinePipelineMode: 'meaning_units',
    maxMeaningUnitSourceRows: 1,
  });
  const coverage = assertSourceCoverage(units.sourceSegments, units.translationUnits);

  assert.equal(coverage.valid, true);
  assert.equal(units.translationUnits.length, 2);
  assert.match(units.translationUnits[0].text, /80 km from Assamaka/);
  assert.equal(units.translationUnits[1].text, 'after days on the road most water was gone');
  assert.deepEqual(units.translationUnits[1].sourceRowIds, ['s2']);
});

test('meaning translation units absorb exact duplicate source rows into previous coverage', () => {
  const source = [
    { id: 's1', start: 0, end: 2, text: 'The truck had been stuck in the desert all day' },
    { id: 's2', start: 2, end: 3.2, text: 'The truck had been stuck in the desert all day' },
    { id: 's3', start: 3.2, end: 5, text: 'Everyone was running out of water' },
  ];

  const units = buildTranslationUnits(source, {
    timelinePipelineMode: 'meaning_units',
    maxMeaningUnitSourceRows: 1,
  });
  const coverage = assertSourceCoverage(units.sourceSegments, units.translationUnits);

  assert.equal(coverage.valid, true);
  assert.equal(units.translationUnits.some((unit) => !unit.text), false);
  assert.deepEqual(units.translationUnits[0].sourceRowIds, ['s1', 's2']);
  assert.equal(units.translationUnits[0].text, 'The truck had been stuck in the desert all day');
  assert.equal(units.translationUnits[0].end, 3.2);
});

test('translated units are aligned by meaning id instead of response order', () => {
  const input = [
    { id: 'meaning-001', sourceRowIds: ['groq-1-1'], text: 'First' },
    { id: 'meaning-002', sourceRowIds: ['groq-1-2'], text: 'Second' },
  ];
  const translated = [
    { id: 'meaning-002', text: 'Hai', translatedText: 'Hai' },
    { id: 'meaning-001', text: 'Một', translatedText: 'Một' },
  ];

  const aligned = alignTranslatedUnitsById(input, translated);
  assert.deepEqual(aligned.map((unit) => unit.id), ['meaning-001', 'meaning-002']);
  assert.deepEqual(aligned.map((unit) => unit.translatedText), ['Một', 'Hai']);
  assert.deepEqual(aligned[0].sourceRowIds, ['groq-1-1']);
  assert.throws(
    () => alignTranslatedUnitsById(input, translated.slice(0, 1)),
    /thiếu kết quả: meaning-001/
  );
});

test('qc report detects invalid overlap and dense text', () => {
  const report = createTimelineQcReport('source', [
    { id: 'a', start: 0, end: 2, text: 'A valid cue.' },
    { id: 'b', start: 1.5, end: 1.6, text: 'This cue overlaps and is very dense for its short slot.' },
  ], { qcMaxCharsPerSecond: 10 });

  assert.equal(report.status, 'error');
  assert.ok(report.issues.some((issue) => issue.code === 'OVERLAP'));
  assert.ok(report.issues.some((issue) => issue.code === 'TEXT_TOO_DENSE'));
});

test('readability qc warns and errors on subtitle reading constraints', () => {
  const report = createReadabilityQcReport([
    { id: 'ok', start: 0, end: 4, text: 'Mot cau ngan de doc.' },
    { id: 'fast', start: 4, end: 5, text: 'Day la mot cau phu de rat dai va qua nhanh de nguoi xem co the doc kip.' },
    { id: 'line', start: 5, end: 8, text: 'MotTuRatDaiKhongTheXuongDongTuNhienVaVuotQuaNamMuoiHaiKyTuLienTuc' },
    { id: 'lines', start: 8, end: 11, text: 'dong mot\ndong hai\ndong ba' },
    { id: 'short', start: 11, end: 11.4, text: 'Qua ngan.' },
    { id: 'long', start: 12, end: 20, text: 'Qua dai.' },
  ], {});

  assert.equal(report.status, 'error');
  assert.ok(report.issues.some((issue) => issue.code === 'READING_SPEED_TOO_HIGH'));
  assert.ok(report.issues.some((issue) => issue.code === 'LINE_TOO_LONG' && issue.status === 'error'));
  assert.ok(report.issues.some((issue) => issue.code === 'TOO_MANY_LINES'));
  assert.ok(report.issues.some((issue) => issue.code === 'EVENT_TOO_SHORT_FOR_READING' && issue.status === 'error'));
  assert.ok(report.issues.some((issue) => issue.code === 'EVENT_TOO_LONG'));
});

test('merged display rows keep meaning unit timeline and source ids', () => {
  const sourceSegments = [
    { id: 's1', start: 0, end: 1.2, text: 'He entered' },
    { id: 's2', start: 1.2, end: 3.1, text: 'the cave.' },
    { id: 's3', start: 3.4, end: 5.1, text: 'Water rose.' },
  ];
  const translatedUnits = [
    {
      id: 'meaning-001',
      start: 0,
      end: 3.1,
      sourceText: 'He entered the cave.',
      translatedText: 'Anh ta vao hang.',
      finalText: 'Anh ta vao hang.',
      ttsText: 'Anh ta vao hang.',
      sourceRowIds: ['s1', 's2'],
      sourceIds: ['s1', 's2'],
    },
    {
      id: 'meaning-002',
      start: 3.4,
      end: 5.1,
      sourceText: 'Water rose.',
      translatedText: 'Nuoc dang len.',
      finalText: 'Nuoc dang len.',
      ttsText: 'Nuoc dang len.',
      sourceRowIds: ['s3'],
      sourceIds: ['s3'],
    },
  ];

  const merged = mapTranslatedUnitsToMergedDisplayRows(translatedUnits, sourceSegments, {});
  const tts = buildTtsUnits(merged.displayRows, translatedUnits, {});

  assert.equal(merged.displayRows.length, translatedUnits.length);
  assert.equal(tts.ttsUnits.length, merged.displayRows.length);
  assert.equal(merged.displayRows[0].id, 'meaning-001');
  assert.deepEqual(merged.displayRows[0].sourceRowIds, ['s1', 's2']);
  assert.equal(merged.displayRows[0].start, 0);
  assert.equal(merged.displayRows[0].end, 3.1);
});

test('merged display rows split translated sentences without raw-cue fragmentation', () => {
  const sourceSegments = [
    { id: 's1', start: 0, end: 1.9, text: 'part one' },
    { id: 's2', start: 1.9, end: 4.2, text: 'part two' },
    { id: 's3', start: 4.2, end: 6.9, text: 'part three' },
  ];
  const translatedUnits = [
    {
      id: 'meaning-001',
      start: 0,
      end: 6.9,
      sourceText: 'part one part two part three',
      translatedText: 'Trong hang động tối tăm ẩm ướt, một nhóm thầy trò nhìn về phía trước. Đường ra đã bị lũ chặn kín.',
      finalText: 'Trong hang động tối tăm ẩm ướt, một nhóm thầy trò nhìn về phía trước. Đường ra đã bị lũ chặn kín.',
      sourceRowIds: ['s1', 's2', 's3'],
      sourceIds: ['s1', 's2', 's3'],
    },
  ];

  const merged = mapTranslatedUnitsToMergedDisplayRows(translatedUnits, sourceSegments, {});

  assert.equal(merged.displayRows.length, 2);
  assert.match(merged.displayRows[0].text, /phía trước\.$/);
  assert.match(merged.displayRows[1].text, /^Đường ra/);
  assert.equal(merged.displayRows[0].start, 0);
  assert.equal(merged.displayRows.at(-1).end, 6.9);
});

test('long translated display cues split even without sentence-ending punctuation', () => {
  const rows = splitLongTranslatedDisplaySegments([
    {
      id: 'row-3',
      start: 21.62,
      end: 29.3,
      text: 'Sau do, tren mat cat cua moi cay go, ban duc ra mot phan nho len goi la mong, con phan tuong ung thi khoet thanh ranh lom.',
      translatedText: 'Sau do, tren mat cat cua moi cay go, ban duc ra mot phan nho len goi la mong, con phan tuong ung thi khoet thanh ranh lom.',
      finalText: 'Sau do, tren mat cat cua moi cay go, ban duc ra mot phan nho len goi la mong, con phan tuong ung thi khoet thanh ranh lom.',
    },
  ], {
    timelineOutputMaxChars: 52,
    timelineMaxTranslatedChars: 52,
    timelineOutputMaxCps: 13,
  });

  assert.ok(rows.length >= 2);
  assert.equal(rows[0].start, 21.62);
  assert.equal(rows.at(-1).end, 29.3);
  rows.forEach((row, index) => {
    assert.ok(row.finalText.length <= 70);
    if (index > 0) assert.ok(row.start >= rows[index - 1].end);
  });
});

test('long translated display cues move dangling connective to the next split', () => {
  const text = 'dat chong len no mot doan, roi dung day buoc lai, the la co duoc mot thanh go dai hon.';
  const rows = splitLongTranslatedDisplaySegments([
    {
      id: 'groq-1-1',
      start: 3.723,
      end: 8.9,
      text,
      translatedText: text,
      finalText: text,
    },
  ], {
    timelineOutputMaxChars: 42,
    timelineMaxTranslatedChars: 42,
    timelineOutputMaxCps: 13,
  });

  assert.ok(rows.length >= 2);
  assert.equal(rows.map((row) => row.text).join(' '), text);
  assert.ok(rows.slice(0, -1).every((row) => !/\bthe la[,.!?;:]*$/i.test(row.text)));
  assert.ok(rows.some((row, index) => index > 0 && /^the la\b/i.test(row.text)));
});

test('redistributed translation keeps source group timing boundaries', () => {
  const children = [
    { id: 's1', start: 0, end: 2, text: 'He entered the cave.' },
    { id: 's2', start: 2, end: 4, text: 'The water rose.' },
    { id: 's3', start: 4, end: 6, text: 'Everyone was trapped.' },
  ];
  const output = redistributeTranslatedPackets([
    {
      id: 'packet-1',
      start: 0,
      end: 6,
      text: children.map((child) => child.text).join(' '),
      childSegments: children,
    },
  ], [
    {
      id: 'packet-1',
      translatedText: 'Anh bước vào hang. Nước bất ngờ dâng lên. Tất cả đều mắc kẹt bên trong.',
    },
  ], {
    timelineMaxTranslatedChars: 42,
    timelineOutputMaxChars: 42,
  });

  assert.ok(output.length >= 2);
  assert.equal(output[0].start, 0);
  assert.equal(output[0].end, 2);
  assert.equal(output[1].start, 2);
  assert.equal(output.at(-1).end, 6);
});

test('redistributed translation splits multi-sentence translated cue inside its own timeline', () => {
  const output = redistributeTranslatedPackets([
    {
      id: 'packet-1',
      start: 0,
      end: 7,
      text: 'A long narration cue.',
      childSegments: [
        { id: 's1', start: 0, end: 7, text: 'A long narration cue.' },
      ],
    },
  ], [
    {
      id: 'packet-1',
      translatedText: 'Những người còn lại cũng mắc kẹt, tính mạng ngàn cân treo sợi tóc. Đây chính là sự cố hang Mystery Creek mà hôm nay chúng ta sẽ kể lại.',
    },
  ], {
    timelineMaxTranslatedChars: 46,
    timelineOutputMaxChars: 46,
  });

  assert.ok(output.length > 1);
  assert.equal(output[0].start, 0);
  assert.equal(output.at(-1).end, 7);
  output.forEach((segment, index) => {
    assert.ok(segment.text.length <= 90);
    if (index > 0) assert.ok(segment.start >= output[index - 1].end);
  });
});

test('redistributed translation prefers one completed sentence per timeline cue', () => {
  const output = redistributeTranslatedPackets([
    {
      id: 'packet-1',
      start: 21.7,
      end: 27.54,
      text: 'Long narration.',
      childSegments: [
        { id: 's5', start: 21.7, end: 27.54, text: 'Long narration.' },
      ],
    },
  ], [
    {
      id: 'packet-1',
      translatedText: 'Nhung nguoi con lai cung bi mac ket, tinh mang ngan can treo soi toc. Day chinh la vu hang Mystery Creek ma hom nay chung ta ke lai.',
    },
  ], {
    timelineMaxTranslatedChars: 42,
    timelineOutputMaxChars: 42,
  });

  assert.equal(output.length, 2);
  assert.match(output[0].text, /toc\.$/);
  assert.match(output[1].text, /^Day chinh la/);
  assert.equal(output[0].start, 21.7);
  assert.equal(output.at(-1).end, 27.54);
});

test('tts units keep speech punctuation without changing subtitle text', () => {
  const displayRows = [
    {
      id: 's1',
      start: 0,
      end: 1.2,
      text: 'Chạy đi! Ngay bây giờ!',
      translatedText: 'Chạy đi! Ngay bây giờ!',
      finalText: 'Chạy đi! Ngay bây giờ!',
    },
  ];

  const tts = buildTtsUnits(displayRows, [], { ttsTextCleanupMode: 'natural' });

  assert.equal(displayRows[0].finalText, 'Chạy đi! Ngay bây giờ!');
  assert.equal(tts.ttsUnits[0].finalText, 'Chạy đi! Ngay bây giờ!');
  assert.equal(tts.ttsUnits[0].ttsText, 'Chạy đi! Ngay bây giờ!');
});

test('tts units merge unfinished translated cue with the next line for natural reading', () => {
  const displayRows = [
    {
      id: 's19',
      start: 48.874,
      end: 50.82,
      text: 'Câu chuyện hôm nay xảy ra ở khu vực',
      translatedText: 'Câu chuyện hôm nay xảy ra ở khu vực',
      finalText: 'Câu chuyện hôm nay xảy ra ở khu vực',
    },
    {
      id: 's20',
      start: 50.82,
      end: 54.16,
      text: 'giáp ranh giữa ba nước Niger, Mali và Algeria.',
      translatedText: 'giáp ranh giữa ba nước Niger, Mali và Algeria.',
      finalText: 'giáp ranh giữa ba nước Niger, Mali và Algeria.',
    },
  ];

  const tts = buildTtsUnits(displayRows, [], { ttsTextCleanupMode: 'natural' });

  assert.equal(displayRows.length, 2);
  assert.equal(tts.ttsUnits.length, 1);
  assert.equal(
    tts.ttsUnits[0].ttsText,
    'Câu chuyện hôm nay xảy ra ở khu vực giáp ranh giữa ba nước Niger, Mali và Algeria.'
  );
  assert.deepEqual(tts.ttsUnits[0].sourceRowIds, ['s19', 's20']);
});

test('tts units prefer the unfinished cue over a previous completed sentence tail', () => {
  const displayRows = [
    {
      id: 's127',
      start: 416.22,
      end: 422,
      text: 'Bi bo lai o day. Nhung du vay,',
      translatedText: 'Bi bo lai o day. Nhung du vay,',
      finalText: 'Bi bo lai o day. Nhung du vay,',
    },
    {
      id: 's128',
      start: 422,
      end: 426.5,
      text: 'hanh lang nay van tap nap xe co, vi no khong chi la tuyen chinh',
      translatedText: 'hanh lang nay van tap nap xe co, vi no khong chi la tuyen chinh',
      finalText: 'hanh lang nay van tap nap xe co, vi no khong chi la tuyen chinh',
    },
    {
      id: 's129',
      start: 426.5,
      end: 431,
      text: 'de nguoi dan vuot bien, ma con la duong di cua nhieu lao dong.',
      translatedText: 'de nguoi dan vuot bien, ma con la duong di cua nhieu lao dong.',
      finalText: 'de nguoi dan vuot bien, ma con la duong di cua nhieu lao dong.',
    },
  ];

  const tts = buildTtsUnits(displayRows, [], { ttsTextCleanupMode: 'natural' });

  assert.equal(tts.ttsUnits.length, 2);
  assert.deepEqual(tts.ttsUnits[0].sourceRowIds, ['s127']);
  assert.deepEqual(tts.ttsUnits[1].sourceRowIds, ['s128', 's129']);
  assert.match(tts.ttsUnits[1].ttsText, /tuyen chinh de nguoi dan/);
  assert.equal(tts.ttsUnits[1].start, 422);
  assert.equal(tts.ttsUnits[1].end, 431);
});

test('natural dubbing units respect prosody caps', () => {
  const sourceSegments = [
    { id: 's1', start: 0, end: 1.0, text: 'He looked down' },
    { id: 's2', start: 1.05, end: 2.0, text: 'and saw the water' },
    { id: 's3', start: 2.05, end: 3.0, text: 'rising very fast' },
    { id: 's4', start: 3.05, end: 4.0, text: 'near the cave wall' },
  ];

  const units = buildTranslationUnits(sourceSegments, {
    timelinePipelineMode: 'meaning_units',
    maxMeaningUnitSourceRows: 2,
    hardMaxMeaningUnitDuration: 4.2,
    hardMaxMeaningUnitChars: 110,
  });

  assert.ok(units.translationUnits.length >= 2);
  assert.ok(units.translationUnits.every((unit) => unit.sourceRowIds.length <= 2));
  assert.ok(units.translationUnits.every((unit) => unit.duration <= 4.2));
});

test('long dubbing units keep hard max even with loose config', () => {
  const units = buildTranslationUnits([
    { id: 's1', start: 0, end: 1.8, text: 'Anh ta tiep tuc tien ve phia truoc' },
    { id: 's2', start: 1.85, end: 3.7, text: 'va nhin thay mot dong nuoc lon' },
    { id: 's3', start: 3.75, end: 5.7, text: 'dang tran vao trong hang rat nhanh' },
    { id: 's4', start: 5.75, end: 7.9, text: 'khien ca hai nguoi phai quay lai ngay lap tuc' },
    { id: 's5', start: 7.95, end: 10.2, text: 'nhung luc nay tinh hinh da qua nguy hiem' },
  ], {
    timelinePipelineMode: 'meaning_units',
    naturalDubTargetMaxSeconds: 7.2,
    maxMeaningUnitDuration: 7.8,
    hardMaxMeaningUnitDuration: 8.5,
    maxMeaningUnitSourceRows: 6,
  });

  assert.ok(units.translationUnits.length >= 2);
  assert.ok(units.translationUnits.every((unit) => unit.duration <= 8.5));
});

test('natural dubbing units split on hard pause gap', () => {
  const units = buildTranslationUnits([
    { id: 's1', start: 0, end: 1.2, text: 'He entered the cave' },
    { id: 's2', start: 1.7, end: 3.0, text: 'Water rose suddenly' },
  ], {
    timelinePipelineMode: 'meaning_units',
    meaningUnitHardBreakGapSeconds: 0.5,
  });

  assert.equal(units.translationUnits.length, 2);
  assert.deepEqual(units.translationUnits.map((unit) => unit.sourceRowIds), [['s1'], ['s2']]);
});

test('long dubbing units can merge completed spoken sentences when they are adjacent', () => {
  const units = buildTranslationUnits([
    { id: 's1', start: 0, end: 1.3, text: 'He escaped.' },
    { id: 's2', start: 1.35, end: 2.4, text: 'The water kept rising' },
  ], {
    timelinePipelineMode: 'meaning_units',
  });

  assert.equal(units.translationUnits.length, 1);
  assert.deepEqual(units.translationUnits[0].sourceRowIds, ['s1', 's2']);
});

test('natural dubbing units merge short continuation without exceeding caps', () => {
  const units = buildTranslationUnits([
    { id: 's1', start: 0, end: 0.7, text: 'Anh quay lai' },
    { id: 's2', start: 0.76, end: 1.55, text: 'va tiep tuc boi' },
  ], {
    timelinePipelineMode: 'meaning_units',
  });

  assert.equal(units.translationUnits.length, 1);
  assert.deepEqual(units.translationUnits[0].sourceRowIds, ['s1', 's2']);
  assert.ok(units.translationUnits[0].duration <= 4.2);
});

test('long dubbing units merge natural standalone rows until target length', () => {
  const units = buildTranslationUnits([
    { id: 's1', start: 0, end: 2.4, text: 'Một câu đã đủ dài để đọc riêng' },
    { id: 's2', start: 2.42, end: 4.7, text: 'Một ý mới cũng đủ rõ ràng' },
  ], {
    timelinePipelineMode: 'meaning_units',
  });

  assert.equal(units.translationUnits.length, 1);
  assert.deepEqual(units.translationUnits[0].sourceRowIds, ['s1', 's2']);
});

test('translation qc warns when source numbers disappear', () => {
  const report = createTranslationQcReport(
    [{ id: 's1', start: 0, end: 2, text: 'There are 12 divers.' }],
    [{ id: 'd1', start: 0, end: 2, text: 'Co nhieu tho lan.' }],
    {}
  );

  assert.equal(report.status, 'warn');
  assert.ok(report.issues.some((issue) => issue.code === 'MISSING_NUMBER' && issue.number === '12'));
});

test('tts qc warns when generated audio overflows slot', () => {
  const report = createTtsQcReport(
    [{ id: 'tts-1', start: 0, end: 1, text: 'Xin chao.' }],
    [{ id: 'tts-1', duration: 1.6 }],
    { qcTtsOverflowToleranceSeconds: 0.2 }
  );

  assert.equal(report.status, 'warn');
  assert.ok(report.issues.some((issue) => issue.code === 'TTS_OVERFLOW'));
});
