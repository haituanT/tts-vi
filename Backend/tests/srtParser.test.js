const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSrtEntries,
  segmentsToSrt,
  srtEntriesToSegments,
} = require('../services/googleTranslateService');

test('SRT parser reads timestamps and multiline text', () => {
  const entries = parseSrtEntries([
    '1',
    '00:00:01,000 --> 00:00:02,500',
    'Hello',
    'world',
    '',
    '2',
    '00:00:03,000 --> 00:00:04,250',
    'Next line',
  ].join('\n'));

  assert.equal(entries.length, 2);
  assert.equal(entries[0].index, 1);
  assert.equal(entries[0].start, 1);
  assert.equal(entries[0].end, 2.5);
  assert.equal(entries[0].text, 'Hello world');
});

test('SRT export and segment conversion preserve order', () => {
  const segments = [
    { start: 0, end: 1.25, text: 'First subtitle' },
    { start: 1.5, end: 3, text: 'Second subtitle' },
  ];
  const srt = segmentsToSrt(segments);
  const entries = parseSrtEntries(srt);
  const roundTrip = srtEntriesToSegments(entries);

  assert.equal(entries.length, 2);
  assert.equal(roundTrip[0].text, 'First subtitle');
  assert.equal(roundTrip[1].text, 'Second subtitle');
  assert.ok(roundTrip[0].end <= roundTrip[1].start);
});
