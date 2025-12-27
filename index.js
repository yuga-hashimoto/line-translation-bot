const line = require('@line/bot-sdk');
const axios = require('axios');
const express = require('express');
const OpenAI = require('openai');

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

// 翻訳APIクォータエラーフラグ
let apiQuotaExceeded = false;

// OpenRouter APIの設定
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash-lite";
const OPENROUTER_MODEL2 = process.env.OPENROUTER_MODEL2;  // フォールバック1
const OPENROUTER_MODEL3 = process.env.OPENROUTER_MODEL3;  // フォールバック2

// フォールバックモデルの配列を作成（設定されているもののみ）
const fallbackModels = [OPENROUTER_MODEL2, OPENROUTER_MODEL3].filter(Boolean);

// OpenRouterクライアントの初期化（APIキーが設定されている場合のみ）
let openrouter = null;
if (OPENROUTER_API_KEY) {
  openrouter = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: OPENROUTER_API_KEY
  });
  console.log('OpenRouter API initialized');
  console.log(`Using model: ${OPENROUTER_MODEL}`);
  if (fallbackModels.length > 0) {
    console.log(`Fallback models: ${fallbackModels.join(', ')}`);
  }
} else {
  console.warn('WARNING: OPENROUTER_API_KEY is not set. Translation features will not work.');
}

// Translation System Instruction
const TRANSLATION_SYSTEM_INSTRUCTION = `You are a high-precision multilingual translation AI.

**Translation Rules:**
1. Translate the original text accurately
2. Preserve line breaks in the translation
3. Do not add punctuation marks (? ! . etc.) that are not in the original text
4. Preserve all punctuation and symbols from the original text exactly
5. This translation is for a LINE messenger group chat

**Emoji Handling:**
1. Keep Unicode emojis (😊🎉❤️ etc.) as-is without translation or conversion
2. Do not convert emojis to text like "(emoji)", "（絵文字）", "(이모지)", or "(表情符號)"
3. Do not include text representations like "(emoji)", "(絵文字)", "(이모지)", or "(表情符號)" in translations
4. Exclude LINE emoji text representations (e.g., (moon smirk), (brown), (sally)) from translation results
5. Text in the format (xxx) with parentheses are LINE emojis and should be excluded from translation output

**Output Format:**
1. When returning JSON format, strictly follow JSON structure
2. Do not use markdown code block markers (\`\`\`)
3. Do not include any extra characters outside of JSON`;

// DeepL APIの設定（フォールバック用）
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
const DEEPL_API_URL = 'https://api-free.deepl.com/v2/translate';

const client = new line.Client(config);

// クォータエラーかどうかを判定する関数
function isQuotaError(error) {
  return error.message && error.message.includes('429 Too Many Requests') && 
         error.message.includes('quota');
}

// テキストから言語判定の邪魔になる要素を除去する関数
function cleanTextForLanguageDetection(text) {
  // メンション（@ユーザー名）を削除
  // LINEのメンションは @displayName の形式
  let cleaned = text.replace(/@[^\s]+/g, '');

  // URLを削除
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, '');

  // 連続する空白を1つにまとめる
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

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

  // ひらがなは日本語の確実な指標（1文字でもあれば日本語）
  if (hiraganaRatio > 0) return 'ja';

  // カタカナメイン（日本語）
  if (japaneseRatio >= 0.2) return 'ja';

  // 中国語判定を厳格化：ひらがな・カタカナが一切ない、かつ漢字が50%以上
  if (chineseRatio >= 0.5 && hiraganaRatio === 0 && katakanaRatio === 0) return 'zh-TW';

  // ラテン文字が多い場合は英語
  if (latinRatio >= 0.6) return 'en';

  // デフォルトは英語
  return 'en';
}

// ハイブリッド言語検出（高精度）
function detectLanguage(text) {
  // メンションやURLを除去してクリーンなテキストで判定
  const cleanedText = cleanTextForLanguageDetection(text);

  // クリーニング後のテキストが空になった場合は元のテキストを使用
  const textForDetection = cleanedText.length > 0 ? cleanedText : text;

  // 1. 短文や特殊ケースは自前ロジック
  if (textForDetection.length < 10) {
    return detectLanguageFromText(textForDetection);
  }

  // 2. 長文はfrancで高精度検出（francが読み込まれている場合のみ）
  if (franc) {
    try {
      const detected = franc(textForDetection, { minLength: 3 });

      const languageMap = {
        'jpn': 'ja',
        'kor': 'ko',
        'cmn': 'zh-TW',
        'zho': 'zh-TW',
        'eng': 'en'
      };

      const mapped = languageMap[detected];
      if (mapped) {
        return mapped;
      }
    } catch (error) {
      // Franc検出に失敗した場合はフォールバック
    }
  }

  // 3. フォールバック
  return detectLanguageFromText(textForDetection);
}

// OpenRouter APIを使用して言語判定と一括翻訳を同時に行う関数
async function translateWithGeminiBatchAndDetect(text, groupId = null) {
  // OpenRouter APIが初期化されていない場合はnullを返す
  if (!openrouter) {
    console.error('OpenRouter API is not initialized. Please set OPENROUTER_API_KEY.');
    return null;
  }

  try {
    // OpenRouter経由でGemini 2.5 Flash Liteを使用
    
    const languageNames = {
      'ja': '日本語',
      'ko': '한국어', 
      'en': 'English',
      'fr': 'Français',
      'th': 'ภาษาไทย',
      'zh-TW': '繁體中文'
    };
    
    // 特定グループかどうかで翻訳対象言語を決定
    let availableLanguages, targetLanguageDescription;
    if (groupId === FRENCH_ONLY_GROUP_ID) {
      availableLanguages = ['ja', 'fr', 'en', 'zh-TW'];
      targetLanguageDescription = '日本語、フランス語、英語、台湾語（繁体字中国語）';
      } else {
        availableLanguages = ['ja', 'ko', 'zh-TW', 'en'];
        targetLanguageDescription = '日本語、韓国語、台湾語（繁体字中国語）、英語';
      }
    
    // 改行を含むテキストをJSON文字列として安全にエスケープ
    const escapedText = JSON.stringify(text);

    // Create translation examples based on group (showing multiple patterns where detected language is excluded)
    const exampleTranslations = groupId === FRENCH_ONLY_GROUP_ID
      ? `Example 1: When Japanese is detected
{
  "detected_language": "ja",
  "translations": {
    "fr": "Traduction française",
    "en": "English translation",
    "zh-TW": "中文翻譯"
  }
}

Example 2: When English is detected
{
  "detected_language": "en",
  "translations": {
    "ja": "日本語翻訳",
    "fr": "Traduction française",
    "zh-TW": "中文翻譯"
  }
}`
      : `Example 1: When Japanese is detected
{
  "detected_language": "ja",
  "translations": {
    "ko": "한국어 번역",
    "zh-TW": "中文翻譯",
    "en": "English translation"
  }
}

Example 2: When English is detected
{
  "detected_language": "en",
  "translations": {
    "ja": "日本語翻訳",
    "ko": "한국어 번역",
    "zh-TW": "中文翻譯"
  }
}`;

    // Create list of target languages (excluding the original language)
    const targetLanguagesList = availableLanguages.filter(lang => lang !== 'ja').join(', ');

    const prompt = `Detect the language of the following text and translate it into appropriate languages.

Target languages: ${targetLanguageDescription}
Available language codes: ${availableLanguages.join(', ')}

Tasks:
1. Detect the language of the input text
   - Ignore @mentions (e.g., @username) and Chinese person names, detect language based only on the actual message content
   - If hiragana or katakana is present, detect as Japanese
   - If Hangul is present, detect as Korean
   - Consider the context of the entire message for detection

2. Translate into **ALL target languages except the detected language**
   - **CRITICAL: Never include the detected language in the translations object**
   - Example: If you detect English, do NOT include "en" in translations, only translate to other languages
   - Do not omit any languages (except the detected language)
   - Provide translations for all target languages (except the detected language)

3. Use only these language codes strictly: ${availableLanguages.join(', ')}

4. For Traditional Chinese (Taiwan), use only "zh-TW"

5. Provide only one translation per language

Important notes:
- For text like "@毛沢東 こんにちは", ignore "@毛沢東" and detect language from "こんにちは"
- If hiragana is present, detect as Japanese
- Do not be misled by Chinese characters in mentions or person names
- **Never include the detected language in the translations object**
- Translate to all languages except the detected one

Output format (JSON):
${exampleTranslations}

Text to translate:
${escapedText}`;

    // OpenRouter APIを呼び出し
    const apiParams = {
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: "system",
          content: TRANSLATION_SYSTEM_INSTRUCTION
        },
        {
          role: "user",
          content: prompt
        }
      ]
    };

    // フォールバックモデルが設定されている場合は追加
    if (fallbackModels.length > 0) {
      apiParams.extra_body = { models: fallbackModels };
    }

    const completion = await openrouter.chat.completions.create(apiParams);

    // 実際に使用されたモデルをログ出力
    if (completion.model) {
      console.log(`[API] Used model: ${completion.model}`);
    }

    const responseText = completion.choices[0].message.content.trim();

    // JSONをパース
    try {
      let cleanedText = responseText.replace(/```json\s*/, '').replace(/```\s*$/, '');
      cleanedText = cleanedText.trim();

      const result = JSON.parse(cleanedText);

      if (result.detected_language && result.translations) {
        // APIが返すキーを統一（zh, zh-CN -> zh-TW）
        const normalizedTranslations = {};

        for (const [key, value] of Object.entries(result.translations)) {
          let normalizedKey = key;
          // 中国語の各種バリエーションをzh-TWに統一
          if (key === 'zh' || key === 'zh-CN' || key === 'zh-Hans' || key === 'zh-Hant') {
            normalizedKey = 'zh-TW';
          }

          // 既に同じキーが存在する場合は、より短い（一般的な）翻訳を優先
          if (normalizedTranslations[normalizedKey]) {
            if (value.length < normalizedTranslations[normalizedKey].length) {
              normalizedTranslations[normalizedKey] = value;
            }
          } else {
            normalizedTranslations[normalizedKey] = value;
          }
        }

        // detected_languageも正規化
        let normalizedSourceLang = result.detected_language;
        if (result.detected_language === 'zh' || result.detected_language === 'zh-CN' ||
            result.detected_language === 'zh-Hans' || result.detected_language === 'zh-Hant') {
          normalizedSourceLang = 'zh-TW';
        }

        // 検出した言語と同じ言語が翻訳結果に含まれている場合は削除（安全策）
        if (normalizedTranslations[normalizedSourceLang]) {
          console.log(`[Warning] Detected language ${normalizedSourceLang} was included in translations. Removing it.`);
          delete normalizedTranslations[normalizedSourceLang];
        }

        return {
          sourceLang: normalizedSourceLang,
          translations: normalizedTranslations
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
            // Geminiが返すキーを統一（zh, zh-CN -> zh-TW）
            const normalizedTranslations = {};
            for (const [key, value] of Object.entries(result.translations)) {
              let normalizedKey = key;
              // 中国語の各種バリエーションをzh-TWに統一
              if (key === 'zh' || key === 'zh-CN' || key === 'zh-Hans' || key === 'zh-Hant') {
                normalizedKey = 'zh-TW';
              }
              
              // 既に同じキーが存在する場合は、より短い（一般的な）翻訳を優先
              if (normalizedTranslations[normalizedKey]) {
                if (value.length < normalizedTranslations[normalizedKey].length) {
                  normalizedTranslations[normalizedKey] = value;
                }
              } else {
                normalizedTranslations[normalizedKey] = value;
              }
            }
            
            // detected_languageも正規化
            let normalizedSourceLang = result.detected_language;
            if (result.detected_language === 'zh' || result.detected_language === 'zh-CN' ||
                result.detected_language === 'zh-Hans' || result.detected_language === 'zh-Hant') {
              normalizedSourceLang = 'zh-TW';
            }

            // 検出した言語と同じ言語が翻訳結果に含まれている場合は削除（安全策）
            if (normalizedTranslations[normalizedSourceLang]) {
              console.log(`[Warning] Detected language ${normalizedSourceLang} was included in translations. Removing it.`);
              delete normalizedTranslations[normalizedSourceLang];
            }

            return {
              sourceLang: normalizedSourceLang,
              translations: normalizedTranslations
            };
          }
        }
      } catch (regexParseError) {
        console.error('正規表現でのJSON抽出も失敗:', regexParseError.message);
      }
      
      return null;
    }
    
  } catch (error) {
    console.error('Translation API error (language detection + translation):', error);
    
    // クォータエラーの場合はフラグを設定
    if (isQuotaError(error)) {
      console.log('翻訳APIクォータエラーを検出、フラグを設定');
      apiQuotaExceeded = true;
    }
    
    return null;
  }
}

// OpenRouter APIを使用して一括翻訳する関数（フォールバック用）
async function translateWithGeminiBatch(text, targetLanguages) {
  // OpenRouter APIが初期化されていない場合はnullを返す
  if (!openrouter) {
    console.error('OpenRouter API is not initialized. Please set OPENROUTER_API_KEY.');
    return null;
  }

  // クォータエラーが発生している場合はスキップ
  if (apiQuotaExceeded) {
    console.log('翻訳APIクォータエラーのため一括翻訳をスキップ');
    return null;
  }

  try {
    // OpenRouter経由でGemini 2.5 Flash Liteを使用
    
    const languageNames = {
      'ja': 'Japanese',
      'ko': 'Korean',
      'en': 'English',
      'fr': 'French',
      'th': 'Thai',
      'zh-TW': 'Traditional Chinese (Taiwan)'
    };

    // Create list of target languages
    const targetLangList = targetLanguages.map(lang => languageNames[lang]).join(', ');

    // Escape text safely as JSON string (handles line breaks)
    const escapedText = JSON.stringify(text);

    const prompt = `Translate the following text into ${targetLangList}.

Output format (JSON):
{${targetLanguages.map(lang => `"${lang}": "translation result"`).join(', ')}}

Text to translate:
${escapedText}`;

    // OpenRouter APIを呼び出し
    const apiParams = {
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: "system",
          content: TRANSLATION_SYSTEM_INSTRUCTION
        },
        {
          role: "user",
          content: prompt
        }
      ]
    };

    // フォールバックモデルが設定されている場合は追加
    if (fallbackModels.length > 0) {
      apiParams.extra_body = { models: fallbackModels };
    }

    const completion = await openrouter.chat.completions.create(apiParams);

    // 実際に使用されたモデルをログ出力
    if (completion.model) {
      console.log(`[API] Used model: ${completion.model}`);
    }

    const responseText = completion.choices[0].message.content.trim();

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
    console.error('Translation API error:', error);
    return null;
  }
}

// 単一言語翻訳（OpenRouter API使用）
async function translateWithGemini(text, targetLang) {
  // OpenRouter APIが初期化されていない場合はnullを返す
  if (!openrouter) {
    console.error('OpenRouter API is not initialized. Please set OPENROUTER_API_KEY.');
    return null;
  }

  try {
    const languageNames = {
      'ja': 'Japanese',
      'ko': 'Korean',
      'en': 'English',
      'fr': 'French',
      'th': 'Thai',
      'zh': 'Chinese'
    };

    const prompt = `Translate the following text into ${languageNames[targetLang]}. Return only the translation result.

Text to translate:
${text}`;

    // OpenRouter APIを呼び出し
    const apiParams = {
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: "system",
          content: TRANSLATION_SYSTEM_INSTRUCTION
        },
        {
          role: "user",
          content: prompt
        }
      ]
    };

    // フォールバックモデルが設定されている場合は追加
    if (fallbackModels.length > 0) {
      apiParams.extra_body = { models: fallbackModels };
    }

    const completion = await openrouter.chat.completions.create(apiParams);

    // 実際に使用されたモデルをログ出力
    if (completion.model) {
      console.log(`[API] Used model: ${completion.model}`);
    }

    const translatedText = completion.choices[0].message.content.trim();

    return translatedText || null;
  } catch (error) {
    console.error('OpenRouter API翻訳エラー:', error);
    return null;
  }
}

// DeepL APIを使用して翻訳する関数（フォールバック用）
async function translateWithDeepL(text, targetLang) {
  try {
    // DeepL APIの言語コード変換
    const deeplLangMap = {
      'zh-TW': 'ZH', // 台湾語（繁体字中国語）
      'ja': 'JA',
      'ko': 'KO',
      'en': 'EN',
      'fr': 'FR'
      // 'th': タイ語はDeepL APIでサポートされていません
    };
    
    const deeplTargetLang = deeplLangMap[targetLang];
    
    // DeepL APIでサポートされていない言語の場合
    if (!deeplTargetLang) {
      console.log(`DeepL APIは${targetLang}をサポートしていません`);
      return null;
    }
    
    const params = new URLSearchParams();
    params.append('auth_key', DEEPL_API_KEY);
    params.append('text', text);
    params.append('target_lang', deeplTargetLang);
    
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
    console.error('DeepL API error:', error.message);
    return null;
  }
}

// 翻訳を試行する関数（OpenRouter -> DeepLの順）
async function translateText(text, targetLang) {
  // まずOpenRouterで試行
  let result = await translateWithGemini(text, targetLang);

  if (result) {
    return result;
  }

  // OpenRouterが失敗した場合はDeepLをフォールバック
  result = await translateWithDeepL(text, targetLang);

  if (result) {
    return result;
  }

  console.error('すべての翻訳APIが失敗しました');
  return null;
}

// AI言語判定+翻訳を実行する関数
async function translateWithAIDetection(text, groupId = null) {
  // まずAI言語判定+一括翻訳を試行
  const aiResult = await translateWithGeminiBatchAndDetect(text, groupId);

  if (aiResult && aiResult.sourceLang && aiResult.translations && Object.keys(aiResult.translations).length > 0) {
    return {
      sourceLang: aiResult.sourceLang,
      translations: aiResult.translations
    };
  }

  // AIが失敗した場合はフォールバック（従来の方式）
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
  
  // 特定のグループIDの場合は日本語、フランス語、タイ語、台湾語
  if (groupId === FRENCH_ONLY_GROUP_ID) {
    switch (sourceLang) {
        case 'ja':
          targetLanguages = ['fr', 'en', 'zh-TW'];
          break;
        case 'fr':
          targetLanguages = ['ja', 'en', 'zh-TW'];
          break;
        case 'en':
          targetLanguages = ['ja', 'fr', 'zh-TW'];
          break;
        case 'zh-TW':
          targetLanguages = ['ja', 'fr', 'en'];
          break;
        default:
          // その他の言語の場合は4言語すべてに翻訳
          targetLanguages = ['ja', 'fr', 'en', 'zh-TW'];
    }
  } else {
    // 通常のグループの場合は従来通り
    switch (sourceLang) {
      case 'ja':
        targetLanguages = ['ko', 'zh-TW', 'en'];
        break;
      case 'ko':
        targetLanguages = ['ja', 'zh-TW', 'en'];
        break;
      case 'zh-TW':
        targetLanguages = ['ja', 'ko', 'en'];
        break;
      default:
        // その他の言語（英語など）
        targetLanguages = ['ja', 'ko', 'zh-TW'];
    }
  }
  
  // まず一括翻訳を試行
  let translations = await translateWithGeminiBatch(text, targetLanguages);

  if (translations && Object.keys(translations).length > 0) {
    return translations;
  }

  // 一括翻訳が失敗した場合は個別翻訳でフォールバック
  translations = {};
  
  for (const targetLang of targetLanguages) {
    const translated = await translateText(text, targetLang);
    if (translated) {
      translations[targetLang] = translated;
    }
  }
  
  return translations;
}

// テキストを指定された長さのチャンクに分割する関数
function splitTextIntoChunks(text, maxLength) {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks = [];
  let currentChunk = '';
  const sentences = text.split(/(?<=[。！？\n.!?])/); // 文の区切りで分割

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length <= maxLength) {
      currentChunk += sentence;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
      }

      // 1文が長すぎる場合は強制的に分割
      if (sentence.length > maxLength) {
        let remaining = sentence;
        while (remaining.length > 0) {
          chunks.push(remaining.substring(0, maxLength));
          remaining = remaining.substring(maxLength);
        }
        currentChunk = '';
      } else {
        currentChunk = sentence;
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks.length > 0 ? chunks : [text];
}

// 翻訳結果のメッセージを生成する関数
function generateTranslationMessage(originalText, sourceLang, translations) {
  const languageNames = {
    'ja': '🇯🇵 日本語',
    'ko': '🇰🇷 한국어',
    'en': '🇺🇸 English',
    'fr': '🇫🇷 Français',
    'th': '🇹🇭 ภาษาไทย',
    'zh-TW': '🇹🇼 繁體中文'
  };

  // テキストを制限内に収める（LINE Flex Messageの制限対応）
  const truncateText = (text, maxLength = 2000) => {
    if (!text) return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
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

  // 翻訳結果を追加（すべての翻訳を表示）
  const translationEntries = Object.entries(translations);

  translationEntries.forEach(([lang, text]) => {
    const truncatedText = truncateText(text, 1500); // 各翻訳を1500文字以内に制限

    contents.push(
      {
        type: 'separator',
        margin: 'md'
      },
      {
        type: 'text',
        text: languageNames[lang] || lang,
        weight: 'bold',
        size: 'xs',
        color: '#666666',
        margin: 'md'
      },
      {
        type: 'text',
        text: truncatedText,
        size: 'md',
        wrap: true,
        margin: 'sm'
      }
    );
  });

  // altTextも制限内に収める
  const altText = truncateText(originalText, 400);

  try {
    return {
      type: 'flex',
      altText: altText,
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: contents,
          spacing: 'sm',
          paddingAll: 'lg'
        }
      }
    };
  } catch (error) {
    console.error('Flex Message生成エラー:', error);
    // エラーの場合はシンプルなテキストメッセージにフォールバック
    const fallbackText = `🌍 翻訳結果:\n\n${Object.entries(translations).map(([lang, text]) =>
      `${languageNames[lang] || lang}: ${truncateText(text, 200)}`
    ).join('\n\n')}`;

    return {
      type: 'text',
      text: fallbackText.length > 5000 ? fallbackText.substring(0, 4990) + '...' : fallbackText
    };
  }
}

// 翻訳結果を送信する関数（長文対応）
async function sendTranslationMessages(client, replyToken, groupId, text, sourceLang, translations) {
  const languageNames = {
    'ja': '🇯🇵 日本語',
    'ko': '🇰🇷 한국어',
    'en': '🇺🇸 English',
    'fr': '🇫🇷 Français',
    'th': '🇹🇭 ภาษาไทย',
    'zh-TW': '🇹🇼 繁體中文'
  };

  // 最大文字数の確認
  const MAX_SHORT_TEXT = 1500; // この長さ以下ならFlex Messageを使用
  const MAX_LINE_MESSAGE = 4500; // LINEメッセージの安全な上限（余裕を持たせる）

  // すべての翻訳が短い場合は従来のFlex Messageを使用
  const allTranslationsShort = Object.values(translations).every(t => t.length <= MAX_SHORT_TEXT);

  if (allTranslationsShort) {
    const replyMessage = generateTranslationMessage(text, sourceLang, translations);
    await client.replyMessage(replyToken, replyMessage);
    return;
  }

  // 長文の場合：各言語を個別のメッセージとして送信
  const messages = [];

  // 各言語の翻訳をメッセージとして追加
  for (const [lang, translatedText] of Object.entries(translations)) {
    const langName = languageNames[lang] || lang;
    const prefix = `${langName}:\n`;

    // LINEの文字数制限（5000文字）を考慮してテキストを分割
    const maxTextLength = MAX_LINE_MESSAGE - prefix.length;

    if (translatedText.length <= maxTextLength) {
      // 1メッセージで収まる場合
      messages.push({
        type: 'text',
        text: prefix + translatedText
      });
    } else {
      // 分割が必要な場合
      const chunks = splitTextIntoChunks(translatedText, maxTextLength);
      chunks.forEach((chunk, index) => {
        const chunkPrefix = chunks.length > 1
          ? `${langName} (${index + 1}/${chunks.length}):\n`
          : prefix;
        messages.push({
          type: 'text',
          text: chunkPrefix + chunk
        });
      });
    }
  }

  // replyMessageで一度に送信（LINEは最大5件まで）
  if (messages.length > 0) {
    // 最大5件に制限
    const messagesToSend = messages.slice(0, 5);

    // 5件を超える場合は警告をログ出力
    if (messages.length > 5) {
      console.warn(`[Warning] Total messages: ${messages.length}, sending first 5 only`);
    }

    await client.replyMessage(replyToken, messagesToSend);
  }
}

// Webhook処理関数
async function handleWebhook(req, res) {
  // CORS対応
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-line-signature');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    // 署名検証（特定絵文字での問題対応のため一時的にスキップ）
    // 本番運用時は適切な署名検証の実装を検討してください

    if (!req.body) {
      console.error('Empty request body');
      return res.status(400).json({ error: 'Request body is empty' });
    }

    if (!req.body.events || !Array.isArray(req.body.events)) {
      return res.status(200).json({ message: 'No events found' });
    }

    if (req.body.events.length === 0) {
      return res.status(200).json({ message: 'Empty events array' });
    }

    await Promise.all(
      req.body.events.map(async (event, index) => {
        try {
          if (event.type !== 'message') {
            return;
          }

          if (!event.message) {
            return;
          }

          if (event.message.type !== 'text') {
            return;
          }

          // グループチャットのみに制限
          if (event.source.type !== 'group') {
            return;
          }

          const groupId = event.source.groupId;
          const text = event.message.text.trim();

          // replyTokenの存在確認
          if (!event.replyToken) {
            console.error('Missing replyToken');
            return;
          }

          // 空のメッセージは無視
          if (!text) {
            return;
          }

          // 角括弧が含まれている場合は翻訳をスキップ
          if (text.includes('([)') || text.includes('(])')) {
            return;
          }

          // LINE絵文字のみの場合（複数個も含む）翻訳をスキップ
          // LINE絵文字は (xxx) の形式で表現される（emoji, brown, cony, sally等）
          const lineEmojiOnlyPattern = /^(\([^)]+\)\s*)+$/;
          if (lineEmojiOnlyPattern.test(text)) {
            return;
          }

          // URLのみの場合は翻訳をスキップ
          // URLと空白・改行のみで構成されているメッセージを検出
          const urlOnlyPattern = /^(https?:\/\/[^\s]+\s*)+$/;
          if (urlOnlyPattern.test(text)) {
            return;
          }

          console.log(`[Translation] Text: "${text}" | Model: ${OPENROUTER_MODEL}`);
          
          // AI言語判定+翻訳実行
          const result = await translateWithAIDetection(text, groupId);
          const sourceLang = result.sourceLang;
          const translations = result.translations;

          if (Object.keys(translations).length === 0) {
            console.error('Translation failed: empty result');
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: '翻訳に失敗しました。もう一度お試しください。'
            });
            return;
          }

          console.log(`[Translation] Detected: ${sourceLang} | Translations: ${Object.keys(translations).join(', ')}`);

          // 翻訳結果を送信（長文対応版）
          try {
            await sendTranslationMessages(client, event.replyToken, groupId, text, sourceLang, translations);
          } catch (replyError) {
            console.error('Reply error:', replyError.message);
          }
          
        } catch (err) {
          console.error('Event processing error:', err.message);
          return Promise.resolve();
        }
      })
    );

    res.status(200).json({ message: 'OK' });
  } catch (error) {
    console.error('Webhook processing error:', error.message);
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
