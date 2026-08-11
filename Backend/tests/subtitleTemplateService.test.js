const test = require('node:test');
const assert = require('node:assert/strict');

const { _private } = require('../services/subtitleTemplateService');

test('subtitle grouping stays serial unless grouping concurrency is explicit', () => {
  assert.equal(_private.groupingConcurrency({ cliTranslationConcurrency: 5 }, 4), 1);
  assert.equal(_private.groupingConcurrency({}, 4), 1);
});

test('subtitle grouping explicit concurrency is capped by batch count and hard limit', () => {
  assert.equal(_private.groupingConcurrency({ subtitleGroupConcurrency: 3 }, 4), 3);
  assert.equal(_private.groupingConcurrency({ subtitleGroupConcurrency: 10 }, 4), 4);
  assert.equal(_private.groupingConcurrency({ subtitleGroupConcurrency: 10 }, 8), 5);
});
