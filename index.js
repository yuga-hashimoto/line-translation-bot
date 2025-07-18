const line = require('@line/bot-sdk');
const axios = require('axios');

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
  // 日本語の検出（ひらがな、カタカナ、漢字）
  const japanesePattern = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/;
  // 韓国語の検出（ハングル）
  const koreanPattern = /[\uAC00-\uD7AF]/;
  // 中国語の検出（中国語特有の文字）
  const chinesePattern = /[\u4E00-\u9FFF]/;
  
  if (japanesePattern.test(text)) {
    return 'ja';
  } else if (koreanPattern.test(text)) {
    return 'ko';
  } else if (chinesePattern.test(text)) {
    return 'zh';
  } else {
    return 'en'; // デフォルトは英語
  }
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
    altText: '多言語翻訳結果',
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

// Google Cloud Functions のエントリーポイント
exports.lineTranslationBot = async (req, res) => {
  console.log('Translation Webhook received');
  
  // CORS対応
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-line-signature');
  
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  
  if (!req.headers['x-line-signature']) {
    console.error('署名がありません');
    return res.status(200).json({ message: 'Signature is missing' });
  }

  try {
    const signature = req.headers['x-line-signature'];
    
    // 署名検証
    const body = JSON.stringify(req.body);
    const isValid = line.validateSignature(body, config.channelSecret, signature);
    
    if (!isValid) {
      console.error('署名が一致しません');
      return res.status(200).json({ message: 'Invalid signature' });
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
          
          // 言語を検出
          const sourceLang = detectLanguage(text);
          console.log(`検出された言語: ${sourceLang}`);
          
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
};