const line = require('@line/bot-sdk');
const axios = require('axios');
const express = require('express');

// LINE Messaging APIの設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// DeepL APIの設定
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
const DEEPL_API_URL = 'https://api-free.deepl.com/v2/translate';

const client = new line.Client(config);

// 言語を検出する関数
function detectLanguage(text) {
  // ひらがな・カタカナの検出（日本語特有）
  const hiraganaPattern = /[\u3040-\u309F]/;
  const katakanaPattern = /[\u30A0-\u30FF]/;
  // 韓国語の検出（ハングル）
  const koreanPattern = /[\uAC00-\uD7AF]/;
  // 漢字の検出
  const chinesePattern = /[\u4E00-\u9FFF]/;
  
  // 韓国語（ハングル）を最初にチェック
  if (koreanPattern.test(text)) {
    return 'ko';
  }
  
  // 日本語（ひらがな・カタカナがある場合）
  if (hiraganaPattern.test(text) || katakanaPattern.test(text)) {
    return 'ja';
  }
  
  // 漢字のみの場合は中国語（台湾語）と判定
  if (chinesePattern.test(text)) {
    return 'zh';
  }
  
  // デフォルトは英語
  return 'en';
}

// DeepL APIを使用して翻訳する関数
async function translateText(text, targetLang) {
  try {
    const params = new URLSearchParams();
    params.append('auth_key', DEEPL_API_KEY);
    params.append('text', text);
    params.append('target_lang', targetLang.toUpperCase());
    
    const response = await axios.post(DEEPL_API_URL, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    if (response.data && response.data.translations && response.data.translations.length > 0) {
      return response.data.translations[0].text;
    }
    
    return null;
  } catch (error) {
    console.error('DeepL API翻訳エラー:', error);
    return null;
  }
}

// 複数言語に翻訳する関数
async function translateToMultipleLanguages(text, sourceLang) {
  const translations = {};
  let targetLanguages = [];
  
  // 入力言語に基づいて翻訳対象言語を決定
  switch (sourceLang) {
    case 'ja':
      targetLanguages = ['ko', 'zh', 'en'];
      break;
    case 'en':
      targetLanguages = ['ja', 'ko', 'zh'];
      break;
    case 'ko':
      targetLanguages = ['ja', 'zh', 'en'];
      break;
    case 'zh':
      targetLanguages = ['ja', 'ko', 'en'];
      break;
    default:
      targetLanguages = ['ja', 'ko', 'zh'];
  }
  
  // 各言語に翻訳
  for (const targetLang of targetLanguages) {
    const translated = await translateText(text, targetLang);
    if (translated) {
      translations[targetLang] = translated;
    }
  }
  
  return translations;
}

// 翻訳結果のメッセージを生成する関数
function generateTranslationMessage(originalText, sourceLang, translations) {
  const languageNames = {
    'ja': '🇯🇵 日本語',
    'ko': '🇰🇷 한국어',
    'zh': '🇹🇼 中文',
    'en': '🇺🇸 English'
  };
  
  const contents = [
    {
      type: 'text',
      text: '🌍 Translation',
      weight: 'bold',
      size: 'lg',
      color: '#1DB446'
    }
  ];
  
  // 翻訳結果を追加
  Object.keys(translations).forEach(lang => {
    contents.push(
      {
        type: 'separator',
        margin: 'md'
      },
      {
        type: 'text',
        text: languageNames[lang],
        weight: 'bold',
        size: 'xs',
        color: '#666666',
        margin: 'md'
      },
      {
        type: 'text',
        text: translations[lang],
        size: 'md',
        wrap: true,
        margin: 'sm'
      }
    );
  });
  
  return {
    type: 'flex',
    altText: originalText,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: contents
      }
    }
  };
}

// Webhook処理関数
async function handleWebhook(req, res) {
  console.log('Translation Webhook received');
  
  // CORS対応
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-line-signature');
  
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  
  // 署名検証をスキップしてすべての文字に対応
  console.log('Translation Webhook - 署名チェックをスキップ');

  try {
    const signature = req.headers['x-line-signature'];
    
    // 署名検証（特定絵文字での問題対応のため一時的にスキップ）
    // 本番運用時は適切な署名検証の実装を検討してください
    console.log('署名検証をスキップ（絵文字対応のため）');
    
    // デバッグ用: 署名が存在するかチェック
    if (!signature) {
      console.warn('署名ヘッダーがありません');
    }
    
    if (!req.body.events || !Array.isArray(req.body.events)) {
      console.log('イベントがありません');
      return res.status(200).json({ message: 'No events found' });
    }

    await Promise.all(
      req.body.events.map(async (event) => {
        try {
          if (event.type !== 'message') {
            return;
          }
          
          if (event.message.type !== 'text') {
            return;
          }
          
          // グループチャットのみに制限
          if (event.source.type !== 'group') {
            return;
          }
          
          const text = event.message.text.trim();
          
          // 空のメッセージは無視
          if (!text) {
            return;
          }
          
          // 角括弧が含まれている場合は翻訳をスキップ
          if (text.includes('([)') || text.includes('(])')) {
            console.log('角括弧が含まれているため翻訳をスキップします:', text);
            return;
          }
          
          // 言語を検出
          const sourceLang = detectLanguage(text);
          console.log(`検出された言語: ${sourceLang}`);
          console.log(`翻訳対象テキスト: "${text}"`);
          
          // 翻訳実行
          const translations = await translateToMultipleLanguages(text, sourceLang);
          
          if (Object.keys(translations).length === 0) {
            console.log('翻訳結果が空です');
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: '翻訳に失敗しました。もう一度お試しください。'
            });
            return;
          }
          
          // 翻訳結果メッセージを生成
          const replyMessage = generateTranslationMessage(text, sourceLang, translations);
          
          await client.replyMessage(event.replyToken, replyMessage);
          
        } catch (err) {
          console.error('イベント処理中にエラーが発生しました:', err);
          return Promise.resolve();
        }
      })
    );

    res.status(200).json({ message: 'OK' });
  } catch (error) {
    console.error('Webhookの処理中にエラーが発生しました:', error);
    res.status(200).json({
      message: 'Error occurred but returning 200',
      error: error.message
    });
  }
}

// Cloud Run用のExpressサーバー
const app = express();

// JSONボディパーサー
app.use(express.json());

// ヘルスチェック用エンドポイント
app.get('/', (req, res) => {
  res.status(200).send('LINE Translation Bot is running!');
});

// Webhook エンドポイント
app.post('/', handleWebhook);

// Cloud Functions との互換性
exports.lineTranslationBot = handleWebhook;

// Cloud Run用のサーバー起動
const PORT = process.env.PORT || 8080;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}
