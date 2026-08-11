const fs = require('fs').promises;
const crypto = require('crypto');
const axios = require('axios');

let cachedToken = null;

function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function normalizePrivateKey(privateKey) {
  return privateKey.replace(/\\n/g, '\n');
}

async function getServiceAccountToken(credentialsPath, scopes) {
  if (!credentialsPath) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not configured.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) {
    return cachedToken.accessToken;
  }

  const serviceAccount = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
  const tokenUri = serviceAccount.token_uri || 'https://oauth2.googleapis.com/token';
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccount.client_email,
    scope: scopes.join(' '),
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  };

  const unsignedJwt = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(unsignedJwt)
    .sign(normalizePrivateKey(serviceAccount.private_key), 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const assertion = `${unsignedJwt}.${signature}`;
  const response = await axios.post(
    tokenUri,
    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  cachedToken = {
    accessToken: response.data.access_token,
    expiresAt: now + Number(response.data.expires_in || 3600),
  };

  return cachedToken.accessToken;
}

async function getGoogleRequestOptions(config, scopes) {
  if (config.applicationCredentials) {
    const token = await getServiceAccountToken(config.applicationCredentials, scopes);
    return {
      params: {},
      headers: { Authorization: `Bearer ${token}` },
      authType: 'serviceAccount',
    };
  }

  if (config.apiKey) {
    return {
      params: {},
      headers: { 'x-goog-api-key': config.apiKey },
      authType: 'apiKey',
    };
  }

  throw new Error('Missing Google Cloud credentials. Set GOOGLE_APPLICATION_CREDENTIALS in Backend/.env, or choose a service account JSON file in the Google Cloud TTS settings.');
}

module.exports = {
  getGoogleRequestOptions,
};
