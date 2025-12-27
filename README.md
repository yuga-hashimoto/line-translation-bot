# LINE Translation Bot

LINE グループチャット専用の多言語翻訳BOTです。OpenRouter経由でGemini APIを使用し、フォールバックとしてDeepL APIを使用して日本語、韓国語、台湾語、英語間の翻訳を行います。

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

必要な環境変数:
- `LINE_CHANNEL_ACCESS_TOKEN`: LINE Messaging APIのアクセストークン
- `LINE_CHANNEL_SECRET`: LINE Messaging APIのチャネルシークレット
- `OPENROUTER_API_KEY`: OpenRouter APIキー（必須）
- `OPENROUTER_MODEL`: 使用するモデル名（省略可、デフォルト: `google/gemini-2.5-flash-lite`）
- `OPENROUTER_MODEL2`: フォールバックモデル1（省略可）
- `OPENROUTER_MODEL3`: フォールバックモデル2（省略可）
- `DEEPL_API_KEY`: DeepL APIキー（フォールバック用、省略可）

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
  --set-env-vars LINE_CHANNEL_ACCESS_TOKEN=your_token,LINE_CHANNEL_SECRET=your_secret,OPENROUTER_API_KEY=your_key,DEEPL_API_KEY=your_deepl_key
```

### モデルの変更方法

使用するAIモデルを変更するには、`OPENROUTER_MODEL` 環境変数を設定します。

**ローカル環境:**
```bash
# .env ファイルで設定
OPENROUTER_MODEL=google/gemini-2.0-flash-exp:free
```

**本番環境（Cloud Functions/Cloud Run）:**
```bash
# デプロイ時に環境変数を指定
export OPENROUTER_MODEL=google/gemini-2.0-flash-exp:free
npm run deploy
```

**利用可能なモデル例:**
- `google/gemini-2.5-flash-lite` - デフォルト、高速・低コスト
- `google/gemini-2.0-flash-exp:free` - 実験版、無料
- `google/gemini-pro-1.5` - より高性能
- その他のモデルは [OpenRouter Models](https://openrouter.ai/docs#models) を参照

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