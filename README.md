# LINE Translation Bot

LINE グループチャット専用の多言語翻訳BOTです。DeepL APIを使用して日本語、韓国語、台湾語、英語間の翻訳を行います。

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
```bash
# Google Cloud Functions の環境変数として設定
gcloud functions deploy lineTranslationBot \
  --set-env-vars LINE_CHANNEL_ACCESS_TOKEN=your_token,LINE_CHANNEL_SECRET=your_secret,DEEPL_API_KEY=your_deepl_key
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
  --set-env-vars LINE_CHANNEL_ACCESS_TOKEN=your_token,LINE_CHANNEL_SECRET=your_secret,DEEPL_API_KEY=your_deepl_key
```

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