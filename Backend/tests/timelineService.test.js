const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeTtsPunctuation, ttsTextFromTranslation } = require('../services/timelineService');

test('natural tts cleanup keeps punctuation for speech pauses', () => {
  assert.equal(normalizeTtsPunctuation('Run! Right now!', 'natural'), 'Run! Right now!');
  assert.equal(normalizeTtsPunctuation('No... impossible.', 'natural'), 'No... impossible.');
});

test('tts cleanup preserves numeric punctuation and units', () => {
  assert.equal(normalizeTtsPunctuation('Increase from 15% to 30%.', 'natural'), 'Increase from 15% to 30%.');
  assert.equal(normalizeTtsPunctuation('Travel 3.5 km at 10:30.', 'natural'), 'Travel 3.5 km at 10:30.');
});

test('tts cleanup modes choose different punctuation strength', () => {
  assert.equal(normalizeTtsPunctuation('Wait! Can you hear it?', 'fast'), 'Wait Can you hear it');
  assert.equal(normalizeTtsPunctuation('Wait! Can you hear it?', 'strict'), 'Wait! Can you hear it?');
});

test('tts text keeps translated punctuation by default', () => {
  assert.equal(ttsTextFromTranslation('Wait... listen! Do you hear it?'), 'Wait... listen! Do you hear it?');
});

test('tts text verbalizes Vietnamese numbers for speech', () => {
  assert.equal(
    ttsTextFromTranslation('Sahara rộng 9,32 triệu km vuông và có 52 người.', { targetLanguage: 'vi' }),
    'Sahara rộng chín phẩy ba hai triệu ki lô mét vuông và có năm mươi hai người.'
  );
});
