# LINE Translation Bot

LINE グループチャット専用の多言語翻訳BOTです。選択した OpenAI または OpenRouter プロバイダーと、フォールバックとして DeepL APIを使用して日本語、韓国語、台湾語、英語間の翻訳を行います。

## 機能

- **多言語翻訳**: 日本語 ↔ 韓国語・台湾語・英語
- **自動言語検出**: メッセージの言語を自動で判定
- **グループチャット限定**: 個人チャットでは動作しません
- **リッチメッセージ**: LINE Flex Messageで見やすい翻訳結果を表示

## デプロイ方法

### 1. 依存関係のインストール
```bash
npm install
```

### 2. 環境変数の設定

共通の環境変数:
- `LINE_CHANNEL_ACCESS_TOKEN`: LINE Messaging APIのアクセストークン
- `LINE_CHANNEL_SECRET`: LINE Messaging APIのチャネルシークレット
- `DEEPL_API_KEY`: DeepL APIキー（フォールバック用、省略可）

`AI_PROVIDER` で翻訳プロバイダーを選択します。省略時は既存の OpenRouter を使用します。

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

OpenRouter を使用する場合は、`OPENROUTER_API_KEY` が必須です。`OPENROUTER_MODEL` は省略時に `google/gemini-2.5-flash-lite` となり、`OPENROUTER_MODEL2` と `OPENROUTER_MODEL3` でフォールバックモデルを指定できます。OpenAI を使用する場合は、`OPENAI_API_KEY` が必須で、`OPENAI_MODEL` の既定値は `gpt-5.6-luna` です。

```bash
# ローカル開発時は .env ファイルに設定
cp .env.example .env
# .env ファイルを編集して API キーを設定
```

### 3. Google Cloud Functions へのデプロイ
```bash
npm run deploy
```

または手動デプロイ:
```bash
gcloud functions deploy lineTranslationBot \
  --runtime nodejs20 \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars LINE_CHANNEL_ACCESS_TOKEN=your_token,LINE_CHANNEL_SECRET=your_secret,DEEPL_API_KEY=your_deepl_key,AI_PROVIDER=openai,OPENAI_API_KEY=replace_with_a_new_key,OPENAI_MODEL=gpt-5.6-luna,OPENROUTER_API_KEY=replace_with_openrouter_key,OPENROUTER_MODEL=deepseek/deepseek-v5-flash
```

`npm run deploy` は `AI_PROVIDER`、`OPENAI_API_KEY`、`OPENAI_MODEL` を既存の OpenRouter および DeepL 変数とともに渡します。デプロイはスモークテストには含まれません。入力・出力の共有は、有効にした OpenAI プロジェクトにのみ適用されます。

### OpenAI スモークテスト

実際の OpenAI 翻訳を 1 回だけ確認するには、新しく発行したキーをローカルで指定します。キーをリポジトリ、チャット、またはシェル履歴に保存しないでください。

```bash
AI_PROVIDER=openai OPENAI_API_KEY=your_new_key npm run test:openai
```

### フォールバックモデルの設定

プライマリモデルが利用できない場合に自動的に切り替わるフォールバックモデルを設定できます。

**ローカル環境:**
```bash
# .env ファイルで設定
OPENROUTER_MODEL=google/gemini-2.5-flash-lite
OPENROUTER_MODEL2=google/gemini-2.0-flash-exp:free
OPENROUTER_MODEL3=google/gemini-pro-1.5
```

**本番環境（Cloud Functions/Cloud Run）:**
```bash
# デプロイ時に環境変数を指定
export OPENROUTER_MODEL=google/gemini-2.5-flash-lite
export OPENROUTER_MODEL2=google/gemini-2.0-flash-exp:free
export OPENROUTER_MODEL3=google/gemini-pro-1.5
npm run deploy
```

**フォールバックの動作:**
1. まず `OPENROUTER_MODEL` で指定したモデルを使用
2. 失敗した場合、`OPENROUTER_MODEL2` に自動切り替え
3. それも失敗した場合、`OPENROUTER_MODEL3` に切り替え
4. すべて失敗した場合、DeepL APIにフォールバック（設定されている場合）

**注意事項:**
- フォールバックモデルは省略可能です
- 設定しない場合は、プライマリモデルのみ使用されます
- OpenRouterが自動的にフォールバックを処理するため、追加のエラーハンドリングは不要です

### 4. LINE Developer Console の設定
1. Webhook URLを設定: `https://[region]-[project-id].cloudfunctions.net/lineTranslationBot`
2. Webhook を有効にする

## 使用方法

1. LINEグループにBOTを招待
2. グループ内でテキストメッセージを送信
3. 自動で他の言語に翻訳されて返信

## 翻訳パターン

- **日本語** → 韓国語・台湾語・英語
- **英語** → 日本語・韓国語・台湾語
- **韓国語** → 日本語・台湾語・英語
- **台湾語** → 日本語・韓国語・英語

## 注意事項

- グループチャットでのみ動作します
- テキストメッセージのみ翻訳対象です
- DeepL APIの制限により、大量の翻訳リクエストには制限があります
