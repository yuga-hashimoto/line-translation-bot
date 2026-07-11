# OpenAI provider switch design

## Goal

Allow the LINE translation bot to use OpenAI directly with `gpt-5.6-luna` while retaining the existing OpenRouter configuration as a reversible fallback. The default production behavior remains unchanged until `AI_PROVIDER=openai` is explicitly configured.

## Configuration

- `AI_PROVIDER` selects the primary client: `openrouter` (default) or `openai`.
- `OPENAI_API_KEY` is required only when `AI_PROVIDER=openai`.
- `OPENAI_MODEL` defaults to `gpt-5.6-luna` when the OpenAI provider is selected.
- Existing `OPENROUTER_*` and `DEEPL_API_KEY` variables retain their present meanings.
- Documentation and deployment commands will pass the OpenAI variables without printing key material.

## Provider behavior

The code will construct one OpenAI-SDK-compatible client from the selected provider:

- OpenRouter keeps its current base URL, model and optional multi-model fallback behavior.
- OpenAI uses the SDK default base URL and the selected OpenAI model.
- The translation functions will call a shared completion helper. This prevents the three translation paths from drifting in provider-specific behavior.
- OpenRouter-only `extra_body.models` fallback data is never sent to the direct OpenAI API.
- If the selected provider cannot initialize or a completion fails, existing DeepL and non-AI fallback behavior remains in effect.

## Observability and safety

- Startup and translation logs identify the active provider and resolved model, never an API key.
- The application will reject unsupported `AI_PROVIDER` values with a clear startup warning and preserve the existing safe fallback path.
- API keys are supplied only through deployment or local environment variables. They are not committed, written to test fixtures, or printed.

## Verification

1. Unit tests mock the selected client and verify that OpenAI requests use `gpt-5.6-luna` without OpenRouter fallback fields.
2. Existing OpenRouter behavior is covered by a regression test for the fallback field.
3. A one-request opt-in integration check runs only when `OPENAI_API_KEY` is supplied, using a harmless Japanese-to-English translation and reporting the resolved model and status without exposing credentials.
4. No deployment occurs as part of this change. Production cutover remains a separate explicit action.
