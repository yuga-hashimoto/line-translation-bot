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
