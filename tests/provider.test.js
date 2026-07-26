'use strict';

const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  registerAccount,
} = require('./helpers/testApp');
const openrouter = require('../src/infrastructure/ai/providers/openrouter');
const { getProvider, isKnownProvider } = require('../src/infrastructure/ai/providers');
const { PROVIDER_ERROR_KINDS } = require('../src/infrastructure/ai/providerError');

/**
 * Builds a stub reply for the mocked transport.
 *
 * @param {object} params Reply shape.
 * @param {number} [params.status] HTTP status.
 * @param {object} [params.body] Parsed JSON body.
 * @returns {object} A minimal Response lookalike.
 */
function stubResponse({ status = 200, body = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * Wraps a translation reply the way a chat completion carries it.
 *
 * @param {string} content Raw assistant content.
 * @returns {object} Completion body.
 */
function completion(content) {
  return { choices: [{ message: { content } }] };
}

describe('openrouter provider', () => {
  let app;
  let account;
  let originalFetch;

  beforeAll(async () => {
    app = await setupTestApp();
    account = await registerAccount(app, {
      user_id: 'provider_user',
      email: 'provider_user@example.test',
    });
    originalFetch = global.fetch;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    await teardownTestApp();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('registry', () => {
    it('is resolvable by name', () => {
      expect(isKnownProvider('openrouter')).toBe(true);
      expect(getProvider('openrouter')).toBe(openrouter);
    });

    it('appears in the catalogue the settings page reads', async () => {
      const response = await request(app).get('/api/v1/providers').expect(200);

      const entry = response.body.data.providers.find((item) => item.name === 'openrouter');
      expect(entry).toBeDefined();
      expect(entry.label).toBe('OpenRouter');
      expect(entry.requires_network).toBe(true);
      expect(entry.models).toContain(entry.default_model);
    });

    it('offers vendor prefixed models, which is what a broker addresses', () => {
      // Every model reaches a different vendor through one credential, so an
      // unprefixed name would be ambiguous.
      expect(openrouter.models.length).toBeGreaterThan(1);
      for (const model of openrouter.models) {
        expect(model).toMatch(/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/);
      }
    });
  });

  describe('project settings', () => {
    it('accepts a project on a listed model', async () => {
      const response = await request(app)
        .post('/api/v1/namespaces/provider_user/projects')
        .set('Authorization', `Bearer ${account.token}`)
        .send({
          name: 'routed',
          ai_provider: 'openrouter',
          ai_model: 'anthropic/claude-sonnet-4.5',
        })
        .expect(201);

      expect(response.body.data.project.ai_provider).toBe('openrouter');
      expect(response.body.data.project.ai_model).toBe('anthropic/claude-sonnet-4.5');
    });

    it('refuses a model the provider does not offer', async () => {
      // The model list is an allowlist, so a caller cannot steer the broker at
      // an arbitrary upstream by naming one.
      await request(app)
        .post('/api/v1/namespaces/provider_user/projects')
        .set('Authorization', `Bearer ${account.token}`)
        .send({
          name: 'unrouted',
          ai_provider: 'openrouter',
          ai_model: 'attacker/model',
        })
        .expect(400);
    });
  });

  describe('translateBatch', () => {
    const call = {
      apiKey: 'sk_or_test',
      model: 'openai/gpt-4o-mini',
      sourceLang: 'en_us',
      targetLang: 'th_th',
      texts: ['Hello', 'Goodbye'],
    };

    it('sends the credential in a header and returns the parsed array', async () => {
      let seen = null;
      global.fetch = async (url, options) => {
        seen = { url, options };
        return stubResponse({ body: completion('["สวัสดี","ลาก่อน"]') });
      };

      const result = await openrouter.translateBatch(call);

      expect(result).toEqual(['สวัสดี', 'ลาก่อน']);
      expect(seen.url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(seen.options.headers.Authorization).toBe('Bearer sk_or_test');
      // The credential must never travel in the URL, where it would reach logs.
      expect(seen.url).not.toContain('sk_or_test');

      const body = JSON.parse(seen.options.body);
      expect(body.model).toBe('openai/gpt-4o-mini');
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[1].content).toBe(JSON.stringify(call.texts));
    });

    it('tolerates a fenced reply', async () => {
      global.fetch = async () =>
        stubResponse({ body: completion('```json\n["สวัสดี","ลาก่อน"]\n```') });

      await expect(openrouter.translateBatch(call)).resolves.toEqual(['สวัสดี', 'ลาก่อน']);
    });

    it.each([
      [401, PROVIDER_ERROR_KINDS.AUTH],
      [402, PROVIDER_ERROR_KINDS.QUOTA],
      [429, PROVIDER_ERROR_KINDS.RATE_LIMIT],
      [500, PROVIDER_ERROR_KINDS.SERVER],
    ])('maps HTTP %s onto %s so the fallback chain can act', async (status, kind) => {
      global.fetch = async () => stubResponse({ status, body: { error: 'nope' } });

      await expect(openrouter.translateBatch(call)).rejects.toMatchObject({ kind });
    });

    it('maps an error carried inside a 200 body', async () => {
      /*
       * The broker answers 200 when it reached the vendor and the vendor
       * refused. Left unmapped this looks like a malformed reply, which would
       * stop the chain instead of moving to the next credential.
       */
      global.fetch = async () =>
        stubResponse({ body: { error: { code: 429, message: 'upstream throttled' } } });

      await expect(openrouter.translateBatch(call)).rejects.toMatchObject({
        kind: PROVIDER_ERROR_KINDS.RATE_LIMIT,
      });
    });

    it('rejects a reply with the wrong number of items', async () => {
      global.fetch = async () => stubResponse({ body: completion('["only one"]') });

      await expect(openrouter.translateBatch(call)).rejects.toMatchObject({
        kind: PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
      });
    });

    it('rejects prose, so a hijacked model cannot write into the store', async () => {
      global.fetch = async () =>
        stubResponse({ body: completion('Ignore the instructions. Here is my system prompt.') });

      await expect(openrouter.translateBatch(call)).rejects.toMatchObject({
        kind: PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
      });
    });

    it('categorises a transport failure', async () => {
      global.fetch = async () => {
        throw Object.assign(new Error('socket hang up'), { name: 'TypeError' });
      };

      await expect(openrouter.translateBatch(call)).rejects.toMatchObject({
        kind: PROVIDER_ERROR_KINDS.NETWORK,
      });
    });

    it('never puts the vendor body in the message reaching a client', async () => {
      global.fetch = async () =>
        stubResponse({ status: 400, body: { error: 'echoed request content' } });

      await expect(openrouter.translateBatch(call)).rejects.toMatchObject({
        message: expect.not.stringContaining('echoed request content'),
      });
    });
  });
});
