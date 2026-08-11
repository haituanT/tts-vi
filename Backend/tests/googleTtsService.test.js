const test = require('node:test');
const assert = require('node:assert/strict');

const { _private } = require('../services/googleTtsService');

test('Google TTS omits NEUTRAL gender because the API does not support it', async () => {
  const voice = await _private.buildGoogleVoiceConfig({
    ttsProvider: 'google_cloud_tts',
    ttsLanguageCode: 'vi-VN',
    voiceGenderFilter: 'all',
    ssmlGender: 'NEUTRAL',
  });

  assert.deepEqual(voice, { languageCode: 'vi-VN' });
});
