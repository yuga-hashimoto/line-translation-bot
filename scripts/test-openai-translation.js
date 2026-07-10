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
