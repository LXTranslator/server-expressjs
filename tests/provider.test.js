'use strict';

const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  registerAccount,
} = require('./helpers/testApp');
const openrouter = require('../src/infrastructure/ai/providers/openrouter');
const openai = require('../src/infrastructure/ai/providers/openai');
const anthropic = require('../src/infrastructure/ai/providers/anthropic');
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

/*
 * Every adapter that reaches a vendor.
 *
 * The error contract is what the fallback chain acts on, so each call is held
 * to it: the category, the operator message, the status and the provider
 * recorded on the error. The credential header each vendor expects is pinned
 * too, since a request that lost it would fail only in production.
 */
describe('network adapters', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const translateArgs = {
    apiKey: 'sk_test',
    model: 'any-model',
    sourceLang: 'en_us',
    targetLang: 'th_th',
    texts: ['Hello'],
  };
  const chatArgs = {
    apiKey: 'sk_test',
    model: 'any-model',
    system: 'Be brief.',
    messages: [{ role: 'user', content: 'Hi' }],
    tools: [{ name: 'stop', description: 'Finish.', parameters: { type: 'object' } }],
  };
  const embedArgs = { apiKey: 'sk_test', model: 'any-model', input: 'Hi' };

  const bearer = { Authorization: 'Bearer sk_test' };
  const anthropicHeaders = { 'x-api-key': 'sk_test', 'anthropic-version': '2023-06-01' };

  const CALLS = [
    {
      name: 'openai.translateBatch',
      run: () => openai.translateBatch(translateArgs),
      url: 'https://api.openai.com/v1/chat/completions',
      headers: bearer,
      label: 'OpenAI',
      provider: 'openai',
      action: 'request',
      success: { choices: [{ message: { content: '{"translations":["สวัสดี"]}' } }] },
      result: ['สวัสดี'],
      body: { model: 'any-model', response_format: { type: 'json_object' } },
    },
    {
      name: 'openai.chat',
      run: () => openai.chat(chatArgs),
      url: 'https://api.openai.com/v1/chat/completions',
      headers: bearer,
      label: 'OpenAI',
      provider: 'OpenAI',
      action: 'request',
      success: { choices: [{ message: { content: 'Hello' } }], usage: { total_tokens: 7 } },
      result: { text: 'Hello', toolCalls: [], usage: { totalTokens: 7 } },
      body: { model: 'any-model' },
    },
    {
      name: 'openai.embed',
      run: () => openai.embed(embedArgs),
      url: 'https://api.openai.com/v1/embeddings',
      headers: bearer,
      label: 'OpenAI',
      provider: 'OpenAI',
      action: 'embedding request',
      success: { data: [{ embedding: [0.5, 0.25] }] },
      result: [0.5, 0.25],
      body: { model: 'any-model', input: 'Hi' },
    },
    {
      name: 'openrouter.translateBatch',
      run: () => openrouter.translateBatch(translateArgs),
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { ...bearer, 'X-Title': 'LXTranslator' },
      label: 'OpenRouter',
      provider: 'openrouter',
      action: 'request',
      success: { choices: [{ message: { content: '["สวัสดี"]' } }] },
      result: ['สวัสดี'],
      body: { model: 'any-model' },
    },
    {
      name: 'openrouter.chat',
      run: () => openrouter.chat(chatArgs),
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { ...bearer, 'X-Title': 'LXTranslator' },
      label: 'OpenRouter',
      provider: 'OpenRouter',
      action: 'request',
      success: { choices: [{ message: { content: 'Hello' } }], usage: { total_tokens: 7 } },
      result: { text: 'Hello', toolCalls: [], usage: { totalTokens: 7 } },
      body: { model: 'any-model' },
    },
    {
      name: 'openrouter.embed',
      run: () => openrouter.embed(embedArgs),
      url: 'https://openrouter.ai/api/v1/embeddings',
      headers: { ...bearer, 'X-Title': 'LXTranslator' },
      label: 'OpenRouter',
      provider: 'OpenRouter',
      action: 'embedding request',
      success: { data: [{ embedding: [0.5, 0.25] }] },
      result: [0.5, 0.25],
      body: { model: 'any-model', input: 'Hi' },
    },
    {
      name: 'anthropic.translateBatch',
      run: () => anthropic.translateBatch(translateArgs),
      url: 'https://api.anthropic.com/v1/messages',
      headers: anthropicHeaders,
      label: 'Anthropic',
      provider: 'anthropic',
      action: 'request',
      success: { content: [{ type: 'text', text: '["สวัสดี"]' }] },
      result: ['สวัสดี'],
      body: { model: 'any-model', max_tokens: 8192 },
    },
    {
      name: 'anthropic.chat',
      run: () => anthropic.chat(chatArgs),
      url: 'https://api.anthropic.com/v1/messages',
      headers: anthropicHeaders,
      label: 'Anthropic',
      provider: 'anthropic',
      action: 'request',
      success: {
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 'call_1', name: 'stop', input: { summary: 'done' } },
        ],
        usage: { input_tokens: 5, output_tokens: 2 },
      },
      result: {
        text: 'Hello',
        toolCalls: [{ id: 'call_1', name: 'stop', arguments: { summary: 'done' } }],
        usage: { totalTokens: 7 },
      },
      body: { model: 'any-model', max_tokens: 8192 },
    },
  ];

  describe.each(CALLS)('$name', (call) => {
    it('posts JSON to its constant endpoint with the credential in a header', async () => {
      let seen = null;
      global.fetch = async (url, options) => {
        seen = { url, options };
        return stubResponse({ body: call.success });
      };

      await expect(call.run()).resolves.toEqual(call.result);

      expect(seen.url).toBe(call.url);
      expect(seen.options.method).toBe('POST');
      expect(seen.options.signal).toBeInstanceOf(AbortSignal);
      expect(seen.options.headers).toEqual({
        'Content-Type': 'application/json',
        ...call.headers,
      });
      expect(JSON.parse(seen.options.body)).toMatchObject(call.body);
    });

    it('categorises a transport failure', async () => {
      global.fetch = async () => {
        throw new TypeError('fetch failed');
      };

      await expect(call.run()).rejects.toMatchObject({
        name: 'ProviderError',
        kind: PROVIDER_ERROR_KINDS.NETWORK,
        message: `The ${call.label} ${call.action} could not be completed.`,
        status: null,
        provider: call.provider,
      });
    });

    it('categorises a deadline as a timeout', async () => {
      global.fetch = async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      };

      await expect(call.run()).rejects.toMatchObject({ kind: PROVIDER_ERROR_KINDS.TIMEOUT });
    });

    it('maps a status and keeps the vendor body out of the message', async () => {
      global.fetch = async () => stubResponse({ status: 503, body: { error: 'echoed' } });

      const error = await call.run().catch((caught) => caught);

      expect(error).toMatchObject({
        name: 'ProviderError',
        kind: PROVIDER_ERROR_KINDS.SERVER,
        message: `${call.label} responded with status 503.`,
        status: 503,
        provider: call.provider,
      });
      expect(error.cause.message).toBe('{"error":"echoed"}');
    });

    it('rejects a body that is not JSON', async () => {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
        text: async () => 'not json',
      });

      await expect(call.run()).rejects.toMatchObject({
        name: 'ProviderError',
        kind: PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
        message: `${call.label} returned a body that was not valid JSON.`,
        status: null,
        provider: call.provider,
      });
    });
  });
});
