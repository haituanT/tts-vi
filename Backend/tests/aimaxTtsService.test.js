const test = require('node:test');
const assert = require('node:assert/strict');

const aimaxTtsService = require('../services/aimaxTtsService');

function waitTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('AIMAX global job limiter waits for a slot before starting the next job', async () => {
  const limiter = aimaxTtsService._private;
  limiter.resetAimaxJobSlotsForTest();

  const releaseFirst = await limiter.acquireAimaxJobSlot({ aimaxMaxConcurrentJobs: 2 });
  const releaseSecond = await limiter.acquireAimaxJobSlot({ aimaxMaxConcurrentJobs: 2 });
  let thirdAcquired = false;
  const third = limiter.acquireAimaxJobSlot({ aimaxMaxConcurrentJobs: 2 }).then((release) => {
    thirdAcquired = true;
    return release;
  });

  await waitTurn();
  assert.equal(limiter.activeAimaxJobSlotsForTest(), 2);
  assert.equal(thirdAcquired, false);

  releaseFirst();
  const releaseThird = await third;
  assert.equal(thirdAcquired, true);
  assert.equal(limiter.activeAimaxJobSlotsForTest(), 2);

  releaseSecond();
  releaseThird();
  assert.equal(limiter.activeAimaxJobSlotsForTest(), 0);
});

test('AIMAX global job limiter hard-caps configured values at 30', () => {
  const limiter = aimaxTtsService._private;

  assert.equal(limiter.resolveMaxConcurrentJobs({ aimaxMaxConcurrentJobs: 60 }), 30);
  assert.equal(limiter.resolveMaxConcurrentJobs({ aimaxMaxConcurrentJobs: -5 }), 30);
  assert.equal(limiter.resolveMaxConcurrentJobs({ aimaxMaxConcurrentJobs: 12 }), 12);
});

test('AIMAX poll timeout defaults to waiting until the provider returns', () => {
  const limiter = aimaxTtsService._private;
  const previousAimaxTimeout = process.env.AIMAX_TTS_POLL_TIMEOUT_MS;
  const previousDubFlowTimeout = process.env.DUBFLOW_AIMAX_TTS_POLL_TIMEOUT_MS;

  try {
    delete process.env.AIMAX_TTS_POLL_TIMEOUT_MS;
    delete process.env.DUBFLOW_AIMAX_TTS_POLL_TIMEOUT_MS;

    assert.equal(limiter.resolvePollTimeoutMs({}), 0);
    assert.equal(limiter.resolvePollTimeoutMs({ aimaxPollTimeoutMs: 0 }), 0);
    assert.equal(limiter.resolvePollTimeoutMs({ aimaxPollTimeoutMs: 5000 }), 30000);
    assert.equal(limiter.resolvePollTimeoutMs({ aimaxPollTimeoutMs: 120000 }), 120000);

    process.env.AIMAX_TTS_POLL_TIMEOUT_MS = '90000';
    assert.equal(limiter.resolvePollTimeoutMs({}), 90000);
  } finally {
    if (previousAimaxTimeout === undefined) {
      delete process.env.AIMAX_TTS_POLL_TIMEOUT_MS;
    } else {
      process.env.AIMAX_TTS_POLL_TIMEOUT_MS = previousAimaxTimeout;
    }

    if (previousDubFlowTimeout === undefined) {
      delete process.env.DUBFLOW_AIMAX_TTS_POLL_TIMEOUT_MS;
    } else {
      process.env.DUBFLOW_AIMAX_TTS_POLL_TIMEOUT_MS = previousDubFlowTimeout;
    }
  }
});

test('AIMAX extracts segments_url from documented job responses', () => {
  const helpers = aimaxTtsService._private;

  assert.equal(
    helpers.extractSegmentsUrl({ segments_url: 'https://cdn.example/segments.zip' }),
    'https://cdn.example/segments.zip'
  );
  assert.equal(
    helpers.extractSegmentsUrl({ result: { segmentsUrl: '/audio/job_segments.zip' } }),
    '/audio/job_segments.zip'
  );
});

test('AIMAX TTS requests do not send pitch control', async () => {
  const helpers = aimaxTtsService._private;
  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (_url, options = {}) => {
    capturedBody = options.body;
    return new Response(JSON.stringify({ job_id: 'job_123' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await helpers.createTtsJob('Xin chao', {
      aimaxApiKey: 'ak_test',
      ttsVoiceName: 'voice_test',
      aimaxProvider: 'minimax',
      aimaxModel: 'speech-2.8-hd',
      speakingRate: 1.05,
      pitch: -2,
    });

    assert.equal(capturedBody.get('speed'), '1.05');
    assert.equal(capturedBody.has('pitch'), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AIMAX formats Cloudflare 502 pages as transient provider errors', () => {
  const helpers = aimaxTtsService._private;
  const detail = helpers.describeAimaxApiFailure(
    { status: 502, statusText: 'Bad Gateway' },
    { raw: '<!DOCTYPE html><html><head><title>aimaxstudio.com | 502: Bad gateway</title></head><body>Cloudflare</body></html>' }
  );

  assert.equal(helpers.isTransientHttpStatus(502), true);
  assert.match(detail, /AIMAX server returned 502 Bad Gateway/);
  assert.match(detail, /temporary AIMAX\/Cloudflare server error/);
  assert.doesNotMatch(detail, /<!DOCTYPE html>/i);
});
