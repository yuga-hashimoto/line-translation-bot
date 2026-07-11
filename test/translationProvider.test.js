const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTranslationProvider } = require('../lib/translationProvider');

function createOpenAIDouble() {
  const instances = [];
  class FakeOpenAI {
    constructor(options) {
      this.options = options;
      this.chat = { completions: { create: async (params) => ({ model: params.model, params }) } };
      instances.push(this);
    }
  }
  return { FakeOpenAI, instances };
}

test('OpenAI provider uses gpt-5.6-luna and omits OpenRouter fallback fields', async () => {
  const { FakeOpenAI, instances } = createOpenAIDouble();
  const provider = createTranslationProvider({
    env: { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' },
    OpenAIClient: FakeOpenAI,
    logger: { info() {}, warn() {} },
  });

  const completion = await provider.createChatCompletion([{ role: 'user', content: 'こんにちは' }]);

  assert.equal(provider.name, 'openai');
  assert.equal(provider.model, 'gpt-5.6-luna');
  assert.equal(provider.isReady, true);
  assert.deepEqual(instances[0].options, { apiKey: 'test-key' });
  assert.deepEqual(completion.params, {
    model: 'gpt-5.6-luna',
    messages: [{ role: 'user', content: 'こんにちは' }],
  });
});

test('OpenRouter provider preserves its base URL and fallback models', async () => {
  const { FakeOpenAI, instances } = createOpenAIDouble();
  const provider = createTranslationProvider({
    env: {
      OPENROUTER_API_KEY: 'router-key',
      OPENROUTER_MODEL: 'deepseek/deepseek-v5-flash',
      OPENROUTER_MODEL2: 'fallback/a',
      OPENROUTER_MODEL3: 'fallback/b',
    },
    OpenAIClient: FakeOpenAI,
    logger: { info() {}, warn() {} },
  });

  const completion = await provider.createChatCompletion([{ role: 'user', content: 'hello' }]);

  assert.equal(provider.name, 'openrouter');
  assert.equal(instances[0].options.baseURL, 'https://openrouter.ai/api/v1');
  assert.deepEqual(completion.params.extra_body, { models: ['fallback/a', 'fallback/b'] });
});

test('missing or unsupported provider configuration is unavailable without a client', () => {
  const warnings = [];
  const logger = { info() {}, warn: (message) => warnings.push(message) };
  const missing = createTranslationProvider({ env: { AI_PROVIDER: 'openai' }, logger });
  const unsupported = createTranslationProvider({ env: { AI_PROVIDER: 'unknown' }, logger });

  assert.equal(missing.isReady, false);
  assert.equal(unsupported.isReady, false);
  assert.match(warnings.join('\n'), /OPENAI_API_KEY is not set/);
  assert.match(warnings.join('\n'), /Unsupported AI_PROVIDER: unknown/);
});

test('translation entry points delegate to the selected provider', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.equal((source.match(/translationProvider\.createChatCompletion\(messages\)/g) || []).length, 3);
  assert.equal(source.includes('openrouter.chat.completions.create(apiParams)'), false);
});
