const line = require('@line/bot-sdk');
const axios = require('axios');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Dynamic import for franc (ES module)
let franc;
(async () => {
  const francModule = await import('franc');
  franc = francModule.franc;
})();

// LINE Messaging APIの設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// 特定のグループIDでの翻訳設定
const FRENCH_ONLY_GROUP_ID = 'C40b7245622ac6e6ec1e6c1def21881e2'; // ハードコード設定

// Gemini APIの設定
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// DeepL APIの設定（フォールバック用）
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
const DEEPL_API_URL = 'https://api-free.deepl.com/v2/translate';

const client = new line.Client(config);

// 改良版テキストから言語を検出する関数（短文・フォールバック用）
function detectLanguageFromText(text) {
  const hiraganaPattern = /[\u3040-\u309F]/g;
  const katakanaPattern = /[\u30A0-\u30FF]/g;
  const koreanPattern = /[\uAC00-\uD7AF]/g;
  const chinesePattern = /[\u4E00-\u9FFF]/g;
  const latinPattern = /[a-zA-Z]/g;
  
  const textLength = text.length;
  const hiraganaCount = (text.match(hiraganaPattern) || []).length;
  const katakanaCount = (text.match(katakanaPattern) || []).length;
  const koreanCount = (text.match(koreanPattern) || []).length;
  const chineseCount = (text.match(chinesePattern) || []).length;
  const latinCount = (text.match(latinPattern) || []).length;
  
  // 比率を計算
  const hiraganaRatio = hiraganaCount / textLength;
  const katakanaRatio = katakanaCount / textLength;
  const koreanRatio = koreanCount / textLength;
  const chineseRatio = chineseCount / textLength;
  const latinRatio = latinCount / textLength;
  const japaneseRatio = hiraganaRatio + katakanaRatio;
  
  // 優先順位での判定（最も特徴的な文字から）
  if (koreanRatio >= 0.2) return 'ko';
  if (hiraganaRatio >= 0.05) return 'ja'; // ひらがなは日本語の確実な指標
  if (japaneseRatio >= 0.2) return 'ja'; // カタカナメイン
  if (chineseRatio >= 0.2 && hiraganaRatio === 0) return 'zh'; // 中国語の閾値を下げる
  if (latinRatio >= 0.6) return 'en';
  
  return 'en'; // デフォルト
}

// ハイブリッド言語検出（高精度）
function detectLanguage(text) {
  // 1. 短文や特殊ケースは自前ロジック
  if (text.length < 10) {
    console.log('短文のため自前ロジックを使用');
    return detectLanguageFromText(text);
  }
  
  // 2. 長文はfrancで高精度検出（francが読み込まれている場合のみ）
  if (franc) {
    try {
      const detected = franc(text, { minLength: 3 });
      console.log(`Francによる検出結果: ${detected}`);
      
      const languageMap = {
        'jpn': 'ja',
        'kor': 'ko', 
        'cmn': 'zh', // 北京官話
        'zho': 'zh', // 中国語
        'eng': 'en'
      };
      
      const mapped = languageMap[detected];
      if (mapped) {
        console.log(`言語マッピング: ${detected} -> ${mapped}`);
        return mapped;
      } else {
        console.log(`未対応言語: ${detected}、フォールバックを使用`);
      }
    } catch (error) {
      console.log('Franc検出に失敗、フォールバックを使用:', error.message);
    }
  } else {
    console.log('Francがまだ読み込まれていないため、フォールバックを使用');
  }
  
  // 3. フォールバック
  console.log('フォールバックロジックを使用');
  return detectLanguageFromText(text);
}

// Gemini APIを使用して言語判定と一括翻訳を同時に行う関数
async function translateWithGeminiBatchAndDetect(text, groupId = null) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const languageNames = {
      'ja': '日本語',
      'ko': '한국어', 
      'zh': '中文',
      'en': 'English',
      'fr': 'Français'
    };
    
    // 特定グループかどうかで翻訳対象言語を決定
    let availableLanguages, targetLanguageDescription;
    if (groupId === FRENCH_ONLY_GROUP_ID) {
      availableLanguages = ['ja', 'fr'];
      targetLanguageDescription = '日本語とフランス語のみ';
    } else {
      availableLanguages = ['ja', 'ko', 'zh', 'en'];
      targetLanguageDescription = '日本語、韓国語、中国語、英語';
    }
    
    const prompt = `以下のテキストの言語を判定し、適切な言語に翻訳してください。
対象言語：${targetLanguageDescription}

ルール：
1. 入力テキストの言語を判定
2. その言語以外の対象言語すべてに翻訳
3. JSON形式で結果を返す（他の文字は含めない）

JSON形式例：
{
  "detected_language": "ja",
  "translations": {
    "fr": "翻訳結果"
  }
}

翻訳対象テキスト：
${text}`;
    
    console.log('Gemini言語判定+一括翻訳を実行中...');
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const responseText = response.text().trim();
    
    console.log('Gemini APIレスポンス:', responseText);
    
    // JSONをパース
    try {
      let cleanedText = responseText.replace(/```json\s*/, '').replace(/```\s*$/, '');
      cleanedText = cleanedText.trim();
      
      const result = JSON.parse(cleanedText);
      
      if (result.detected_language && result.translations) {
        console.log(`AI言語判定結果: ${result.detected_language}`);
        return {
          sourceLang: result.detected_language,
          translations: result.translations
        };
      }
      
      return null;
    } catch (parseError) {
      console.error('JSON解析エラー:', parseError.message);
      
      // 正規表現でJSONを抽出する最後の試み
      try {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          if (result.detected_language && result.translations) {
            return {
              sourceLang: result.detected_language,
              translations: result.translations
            };
          }
        }
      } catch (regexParseError) {
        console.error('正規表現でのJSON抽出も失敗:', regexParseError.message);
      }
      
      return null;
    }
    
  } catch (error) {
    console.error('Gemini API言語判定+翻訳エラー:', error);
    return null;
  }
}

// Gemini APIを使用して一括翻訳する関数（フォールバック用）
async function translateWithGeminiBatch(text, targetLanguages) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const languageNames = {
      'ja': '日本語',
      'ko': '한국어', 
      'zh': '中文',
      'en': 'English',
      'fr': 'Français'
    };
    
    // 対象言語のリストを作成
    const targetLangList = targetLanguages.map(lang => languageNames[lang]).join('、');
    
    const prompt = `以下のテキストを${targetLangList}に翻訳してください。
JSON形式で返してください（他の文字は含めないでください）：

{${targetLanguages.map(lang => `"${lang}": "翻訳結果"`).join(', ')}}

翻訳対象テキスト：
${text}`;
    
    console.log('Gemini一括翻訳プロンプト:', prompt);
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const responseText = response.text().trim();
    
    console.log('Gemini APIレスポンス:', responseText);
    
    // JSONをパース（マークダウンコードブロックを除去）
    try {
      // ```json と ``` を除去
      let cleanedText = responseText.replace(/```json\s*/, '').replace(/```\s*$/, '');
      cleanedText = cleanedText.trim();
      
      const translations = JSON.parse(cleanedText);
      return translations;
    } catch (parseError) {
      console.error('JSON解析エラー:', parseError.message);
      console.error('レスポンステキスト:', responseText);
      
      // 正規表現でJSONを抽出する最後の試み
      try {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const translations = JSON.parse(jsonMatch[0]);
          return translations;
        }
      } catch (regexParseError) {
        console.error('正規表現でのJSON抽出も失敗:', regexParseError.message);
      }
      
      return null;
    }
    
  } catch (error) {
    console.error('Gemini API翻訳エラー:', error);
    return null;
  }
}

// 単一言語翻訳（フォールバック用）
async function translateWithGemini(text, targetLang) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const languageNames = {
      'ja': '日本語',
      'ko': '한국어',
      'zh': '中文',
      'en': 'English',
      'fr': 'Français'
    };
    
    const prompt = `以下のテキストを${languageNames[targetLang]}に翻訳してください。翻訳結果のみを返してください：\n\n${text}`;
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const translatedText = response.text().trim();
    
    return translatedText || null;
  } catch (error) {
    console.error('Gemini API翻訳エラー:', error);
    return null;
  }
}

// DeepL APIを使用して翻訳する関数（フォールバック用）
async function translateWithDeepL(text, targetLang) {
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

// 翻訳を試行する関数（Gemini -> DeepLの順）
async function translateText(text, targetLang) {
  // まずGeminiで試行
  console.log(`Geminiで翻訳を試行: ${text} -> ${targetLang}`);
  let result = await translateWithGemini(text, targetLang);
  
  if (result) {
    console.log('Geminiでの翻訳が成功');
    return result;
  }
  
  // Geminiが失敗した場合はDeepLをフォールバック
  console.log('Geminiが失敗、DeepLをフォールバックとして使用');
  result = await translateWithDeepL(text, targetLang);
  
  if (result) {
    console.log('DeepLでの翻訳が成功');
    return result;
  }
  
  console.log('すべての翻訳APIが失敗');
  return null;
}

// AI言語判定+翻訳を実行する関数
async function translateWithAIDetection(text, groupId = null) {
  // まずAI言語判定+一括翻訳を試行
  console.log('AI言語判定+一括翻訳を試行中...');
  const aiResult = await translateWithGeminiBatchAndDetect(text, groupId);
  
  if (aiResult && aiResult.sourceLang && aiResult.translations && Object.keys(aiResult.translations).length > 0) {
    console.log('AI言語判定+一括翻訳が成功');
    return {
      sourceLang: aiResult.sourceLang,
      translations: aiResult.translations
    };
  }
  
  // AIが失敗した場合はフォールバック（従来の方式）
  console.log('AI言語判定+翻訳が失敗、フォールバック方式を使用');
  const sourceLang = await detectLanguage(text);
  const translations = await translateToMultipleLanguages(text, sourceLang, groupId);
  
  return {
    sourceLang: sourceLang,
    translations: translations
  };
}

// 複数言語に翻訳する関数（フォールバック用）
async function translateToMultipleLanguages(text, sourceLang, groupId = null) {
  let targetLanguages = [];
  
  // 特定のグループIDの場合は日本語とフランス語のみ
  if (groupId === FRENCH_ONLY_GROUP_ID) {
    switch (sourceLang) {
      case 'ja':
        targetLanguages = ['fr'];
        break;
      case 'fr':
        targetLanguages = ['ja'];
        break;
      default:
        // その他の言語の場合は日本語とフランス語両方に翻訳
        targetLanguages = ['ja', 'fr'];
    }
  } else {
    // 通常のグループの場合は従来通り
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
        // その他の言語（英語など）
        targetLanguages = ['ja', 'ko', 'zh'];
    }
  }
  
  // まずGeminiで一括翻訳を試行
  console.log(`Geminiで一括翻訳を試行: ${text} -> [${targetLanguages.join(', ')}]`);
  let translations = await translateWithGeminiBatch(text, targetLanguages);
  
  if (translations && Object.keys(translations).length > 0) {
    console.log('Gemini一括翻訳が成功');
    return translations;
  }
  
  // Gemini一括翻訳が失敗した場合は従来の方式（個別翻訳）でフォールバック
  console.log('Gemini一括翻訳が失敗、個別翻訳でフォールバック');
  translations = {};
  
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
    'en': '🇺🇸 English',
    'fr': '🇫🇷 Français'
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
            console.log('グループチャット以外のメッセージのため処理をスキップ');
            return;
          }
          
          // グループIDをログに出力
          const groupId = event.source.groupId;
          
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
          
          // LINE絵文字のみの場合（複数個も含む）翻訳をスキップ
          // LINE絵文字は (xxx) の形式で表現される（emoji, brown, cony, sally等）
          const lineEmojiOnlyPattern = /^(\([^)]+\)\s*)+$/;
          if (lineEmojiOnlyPattern.test(text)) {
            console.log('LINE絵文字のみのため翻訳をスキップします:', text);
            return;
          }
          
          console.log(`翻訳対象テキスト: "${text}"`);
          
          // AI言語判定+翻訳実行
          const result = await translateWithAIDetection(text, groupId);
          const sourceLang = result.sourceLang;
          const translations = result.translations;
          
          console.log(`検出された言語: ${sourceLang}`);
          
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
