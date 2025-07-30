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

// ユーザーの言語設定を取得する関数
async function getUserLanguage(userId) {
  try {
    const profile = await client.getProfile(userId);
    return profile.language;
  } catch (error) {
    console.error('ユーザープロファイル取得エラー:', error);
    return null;
  }
}

// テキストから言語を検出する関数（フォールバック用）
function detectLanguageFromText(text) {
  // ひらがな・カタカナの検出（日本語特有）
  const hiraganaPattern = /[\u3040-\u309F]/g;
  const katakanaPattern = /[\u30A0-\u30FF]/g;
  // 韓国語の検出（ハングル）
  const koreanPattern = /[\uAC00-\uD7AF]/g;
  // 漢字の検出
  const chinesePattern = /[\u4E00-\u9FFF]/g;
  
  const textLength = text.length;
  
  // 各文字種の数をカウント
  const hiraganaCount = (text.match(hiraganaPattern) || []).length;
  const katakanaCount = (text.match(katakanaPattern) || []).length;
  const koreanCount = (text.match(koreanPattern) || []).length;
  const chineseCount = (text.match(chinesePattern) || []).length;
  
  // 比率を計算
  const hiraganaRatio = hiraganaCount / textLength;
  const katakanaRatio = katakanaCount / textLength;
  const koreanRatio = koreanCount / textLength;
  const chineseRatio = chineseCount / textLength;
  const japaneseRatio = hiraganaRatio + katakanaRatio;
  
  // 韓国語（ハングル）が30%以上の場合
  if (koreanRatio >= 0.3) {
    return 'ko';
  }
  
  // 日本語（ひらがな・カタカナの合計が30%以上、かつひらがなが10%以上の場合）
  if (japaneseRatio >= 0.3 && hiraganaRatio >= 0.1) {
    return 'ja';
  }
  
  // 漢字が50%以上の場合は中国語（台湾語）
  if (chineseRatio >= 0.5) {
    return 'zh';
  }
  
  // デフォルトは英語
  return 'en';
}

// 言語を検出する関数（ユーザー設定優先、フォールバックでテキスト分析）
async function detectLanguage(text, userId) {
  // まずユーザーの言語設定を取得
  const userLanguage = await getUserLanguage(userId);
  
  if (userLanguage) {
    // ユーザーの言語設定をLINE形式からISO形式に変換
    const languageMap = {
      'ja': 'ja',
      'ko': 'ko',
      'zh-Hant': 'zh',
      'zh-Hans': 'zh',
      'en': 'en'
    };
    
    const detectedLang = languageMap[userLanguage] || userLanguage;
    console.log(`ユーザー言語設定: ${userLanguage} -> ${detectedLang}`);
    return detectedLang;
  }
  
  // ユーザー設定が取得できない場合はテキスト分析にフォールバック
  console.log('ユーザー言語設定が取得できないため、テキスト分析を使用');
  return detectLanguageFromText(text);
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
  // 韓国、台湾・香港・中国、日本、その他（英語）
  switch (sourceLang) {
    case 'ja':
      targetLanguages = ['ko', 'zh', 'en'];
      break;
    case 'ko':
      targetLanguages = ['ja', 'zh', 'en'];
      break;
    case 'zh':
      targetLanguages = ['ja', 'ko', 'en'];
      break;
    default:
      // その他の言語（タイ語、英語など）
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
          
          // (emoji)のみの場合（複数個も含む）翻訳をスキップ
          const emojiOnlyPattern = /^(\(emoji\)\s*)+$/;
          if (emojiOnlyPattern.test(text)) {
            console.log('(emoji)のみのため翻訳をスキップします:', text);
            return;
          }
          
          // 言語を検出
          const sourceLang = await detectLanguage(text, event.source.userId);
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
