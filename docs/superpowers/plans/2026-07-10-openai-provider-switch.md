# OpenAI Provider Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in direct OpenAI provider using `gpt-5.6-luna`, while preserving the current OpenRouter provider and DeepL fallback behavior.

**Architecture:** Move provider-specific OpenAI SDK construction and chat-completion parameter shaping into a small module. `index.js` creates one provider from environment variables and delegates all three translation call sites to it; only the OpenRouter provider adds `extra_body.models`. A Node built-in test suite verifies both request shapes, and an opt-in script sends a harmless live translation only when an environment key is supplied.

**Tech Stack:** Node.js 20, CommonJS, `openai` SDK, Node built-in test runner, Google Cloud Functions deployment.

## Global Constraints

- `AI_PROVIDER` defaults to `openrouter`; `openai` is the only new accepted value.
- The direct OpenAI default model is exactly `gpt-5.6-luna`.
- Existing `OPENROUTER_*` and `DEEPL_API_KEY` behavior remains unchanged.
- Never commit, log, or place API keys in test fixtures or documentation examples.
- Do not deploy in this change; production cutover is an explicit later action.

---

## File Structure

- Create: `lib/translationProvider.js` — selects and initializes the OpenAI-compatible provider and creates provider-safe chat-completion requests.
- Create: `test/translationProvider.test.js` — unit coverage for OpenAI, OpenRouter, missing credentials, and invalid provider input.
- Create: `scripts/test-openai-translation.js` — opt-in live smoke test using the same provider module and a harmless Japanese-to-English request.
- Modify: `index.js` — replaces OpenRouter globals and the three direct chat-completion call sites with the selected provider.
- Modify: `package.json` — adds `test` and `test:openai` scripts and passes OpenAI provider variables through the deployment command.
- Modify: `README.md` — documents provider selection, safe local test command, and rollback configuration.

### Task 1: Provider module and unit tests

**Files:**
- Create: `lib/translationProvider.js`
- Create: `test/translationProvider.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `env.AI_PROVIDER`, `env.OPENAI_API_KEY`, `env.OPENAI_MODEL`, `env.OPENROUTER_API_KEY`, `env.OPENROUTER_MODEL`, `env.OPENROUTER_MODEL2`, `env.OPENROUTER_MODEL3`.
- Produces: `createTranslationProvider({ env, OpenAIClient, logger })` returning `{ name, model, isReady, createChatCompletion(messages) }`.
- `createChatCompletion(messages)` resolves to the SDK completion object and never receives a raw API key from callers.

- [ ] **Step 1: Add a failing OpenAI-provider test**

Create `test/translationProvider.test.js` with this initial test and a recording SDK double:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
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
```

- [ ] **Step 2: Run the test and verify it fails because the module does not exist**

Run: `node --test test/translationProvider.test.js`

Expected: FAIL with `Cannot find module '../lib/translationProvider'`.

- [ ] **Step 3: Implement the minimal provider module**

Create `lib/translationProvider.js` with this exported factory:

```js
const OpenAI = require('openai');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash-lite';
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-luna';

function createUnavailableProvider(name, model, logger, reason) {
  logger.warn(`Translation provider unavailable: ${reason}`);
  return {
    name,
    model,
    isReady: false,
    async createChatCompletion() {
      throw new Error(reason);
    },
  };
}

function createTranslationProvider({ env = process.env, OpenAIClient = OpenAI, logger = console } = {}) {
  const name = (env.AI_PROVIDER || 'openrouter').toLowerCase();

  if (name === 'openai') {
    const model = env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
    if (!env.OPENAI_API_KEY) {
      return createUnavailableProvider(name, model, logger, 'OPENAI_API_KEY is not set');
    }
    const client = new OpenAIClient({ apiKey: env.OPENAI_API_KEY });
    return {
      name,
      model,
      isReady: true,
      createChatCompletion(messages) {
        return client.chat.completions.create({ model, messages });
      },
    };
  }

  if (name === 'openrouter') {
    const model = env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
    if (!env.OPENROUTER_API_KEY) {
      return createUnavailableProvider(name, model, logger, 'OPENROUTER_API_KEY is not set');
    }
    const fallbackModels = [env.OPENROUTER_MODEL2, env.OPENROUTER_MODEL3].filter(Boolean);
    const client = new OpenAIClient({ baseURL: OPENROUTER_BASE_URL, apiKey: env.OPENROUTER_API_KEY });
    return {
      name,
      model,
      isReady: true,
      createChatCompletion(messages) {
        const params = { model, messages };
        if (fallbackModels.length > 0) params.extra_body = { models: fallbackModels };
        return client.chat.completions.create(params);
      },
    };
  }

  return createUnavailableProvider(name, null, logger, `Unsupported AI_PROVIDER: ${name}`);
}

module.exports = { createTranslationProvider };
```

- [ ] **Step 4: Extend the test file for OpenRouter and safe unavailable states**

Append these tests to `test/translationProvider.test.js`:

```js
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
```

- [ ] **Step 5: Add the test command and run the complete provider suite**

Add this script in `package.json`:

```json
"test": "node --test test/*.test.js"
```

Run: `npm test`

Expected: all three tests PASS.

- [ ] **Step 6: Commit the provider module and tests**

Run:

```bash
git add lib/translationProvider.js test/translationProvider.test.js package.json
git commit -m "feat: add selectable translation provider"
```

Expected: one commit containing only the provider factory, its unit tests, and the test script.

### Task 2: Use the provider in all translation paths

**Files:**
- Modify: `index.js:1-50, 285-646, 1101-1131`
- Modify: `test/translationProvider.test.js`

**Interfaces:**
- Consumes: `createTranslationProvider` from `lib/translationProvider.js`.
- Produces: `translationProvider` as the single client boundary in `index.js`.
- Each of `translateWithGeminiBatchAndDetect`, `translateWithGeminiBatch`, and `translateWithGemini` calls `translationProvider.createChatCompletion(messages)`.

- [ ] **Step 1: Add a failing source-level regression assertion for the three provider calls**

Append this test to `test/translationProvider.test.js`:

```js
const fs = require('node:fs');
const path = require('node:path');

test('translation entry points delegate to the selected provider', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.equal((source.match(/translationProvider\.createChatCompletion\(messages\)/g) || []).length, 3);
  assert.equal(source.includes('openrouter.chat.completions.create(apiParams)'), false);
});
```

- [ ] **Step 2: Run the regression test and verify it fails against the current OpenRouter calls**

Run: `node --test test/translationProvider.test.js --test-name-pattern "translation entry points"`

Expected: FAIL because `translationProvider.createChatCompletion(messages)` does not yet occur three times.

- [ ] **Step 3: Replace global provider setup in `index.js`**

Replace the `OPENROUTER_*`, `fallbackModels`, and `openrouter` setup at `index.js:26-49` with:

```js
const { createTranslationProvider } = require('./lib/translationProvider');

const translationProvider = createTranslationProvider();
const ACTIVE_MODEL = translationProvider.model;

console.log(`Translation provider: ${translationProvider.name}`);
console.log(`Translation model: ${ACTIVE_MODEL || 'unconfigured'}`);
```

Do not log any environment value or API key.

- [ ] **Step 4: Convert each translation function to provider calls**

In all three functions, replace the OpenRouter readiness guard with:

```js
if (!translationProvider.isReady) {
  console.error(`Translation provider ${translationProvider.name} is not initialized.`);
  return null;
}
```

Replace each `apiParams` plus `extra_body` block and `openrouter.chat.completions.create(apiParams)` with:

```js
const messages = [
  { role: 'system', content: TRANSLATION_SYSTEM_INSTRUCTION },
  { role: 'user', content: prompt },
];
const completion = await translationProvider.createChatCompletion(messages);
```

Replace each `completion.model || OPENROUTER_MODEL` with `completion.model || ACTIVE_MODEL` and change the webhook log at `index.js:1101` to:

```js
console.log(`[Translation] Text: "${textForTranslation}" | Provider: ${translationProvider.name} | Model: ${ACTIVE_MODEL}`);
```

Leave the JSON parsing, quota detection, DeepL fallback, and message formatting unchanged.

- [ ] **Step 5: Run the full test suite and syntax check**

Run:

```bash
npm test
node --check index.js
```

Expected: all tests PASS and no syntax output.

- [ ] **Step 6: Commit the integration**

Run:

```bash
git add index.js test/translationProvider.test.js
git commit -m "feat: route translations through selected provider"
```

Expected: one commit that only replaces direct OpenRouter calls with the shared provider boundary.

### Task 3: Add opt-in live verification and operator documentation

**Files:**
- Create: `scripts/test-openai-translation.js`
- Modify: `package.json`
- Modify: `README.md:20-103`

**Interfaces:**
- Consumes: `OPENAI_API_KEY`, optional `OPENAI_MODEL`, and the provider module.
- Produces: a process exit code of `0` on a completed harmless translation and `1` with a credential/configuration error; output contains only status, model and translated text.

- [ ] **Step 1: Add a failing smoke-test invocation to package metadata**

Add this script to `package.json`:

```json
"test:openai": "AI_PROVIDER=openai node scripts/test-openai-translation.js"
```

Run: `npm run test:openai`

Expected: FAIL because `scripts/test-openai-translation.js` does not yet exist. After the next step, the same command must instead fail cleanly with `OPENAI_API_KEY is not set` when no key is supplied.

- [ ] **Step 2: Create the opt-in live smoke-test script**

Create `scripts/test-openai-translation.js`:

```js
const { createTranslationProvider } = require('../lib/translationProvider');

async function main() {
  const provider = createTranslationProvider();
  if (!provider.isReady || provider.name !== 'openai') {
    console.error('Set AI_PROVIDER=openai and OPENAI_API_KEY before running this test.');
    process.exitCode = 1;
    return;
  }

  const completion = await provider.createChatCompletion([
    { role: 'system', content: 'Translate Japanese to English. Return only the translation.' },
    { role: 'user', content: '今日はいい天気です。' },
  ]);
  const text = completion.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI returned an empty translation');

  console.log(JSON.stringify({ status: 'completed', model: completion.model || provider.model, output: text }));
}

main().catch((error) => {
  console.error(`OpenAI smoke test failed: ${error.message}`);
  process.exitCode = 1;
});
```

- [ ] **Step 3: Document provider configuration and explicit rollback**

Replace the OpenRouter-only environment-variable section in `README.md` with provider-aware documentation containing these exact examples:

```bash
# Direct OpenAI with the data-sharing eligible project
AI_PROVIDER=openai
OPENAI_API_KEY=replace_with_a_new_key
OPENAI_MODEL=gpt-5.6-luna

# Roll back without code changes
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=replace_with_openrouter_key
OPENROUTER_MODEL=deepseek/deepseek-v5-flash
```

Add a test command that never includes a real key:

```bash
AI_PROVIDER=openai OPENAI_API_KEY=your_new_key npm run test:openai
```

Update the deployment command to pass `AI_PROVIDER`, `OPENAI_API_KEY`, and `OPENAI_MODEL` alongside the existing variables. State explicitly that deployment is not part of the smoke test and that input/output sharing applies only to the enabled OpenAI project.

- [ ] **Step 4: Verify safe missing-key behavior and the live OpenAI path**

Run:

```bash
npm run test:openai
AI_PROVIDER=openai OPENAI_API_KEY=your_new_key npm run test:openai
```

Expected:

- First command exits `1` and prints `Set AI_PROVIDER=openai and OPENAI_API_KEY before running this test.`
- Second command exits `0` and prints JSON with `status` equal to `completed` and a `gpt-5.6-luna` model identifier.

Use a newly issued key only; do not reuse a key previously pasted into a chat.

- [ ] **Step 5: Run final local verification**

Run:

```bash
npm test
node --check index.js
git diff --check
git status --short
```

Expected: all tests PASS, syntax and whitespace checks produce no errors, and only Task 3 files remain staged or modified before its commit.

- [ ] **Step 6: Commit documentation and smoke-test support**

Run:

```bash
git add README.md package.json scripts/test-openai-translation.js
git commit -m "docs: add OpenAI translation smoke test"
```

Expected: one commit containing only operator documentation, package scripts, deployment variable propagation, and the opt-in smoke test.

## Self-Review

- Spec coverage: Task 1 implements provider selection, safe credentials and OpenRouter fallback shaping; Task 2 connects all translation paths while retaining DeepL and parsing behavior; Task 3 provides the required opt-in real API check and documented rollback without deployment.
- Completeness scan: every code-changing step includes concrete file paths, code, commands, and expected results.
- Type consistency: all consumers use `translationProvider.createChatCompletion(messages)`, and the factory consistently returns `name`, `model`, and `isReady`.
