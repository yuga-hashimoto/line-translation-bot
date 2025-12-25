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

// Geminiクォータエラーフラグ
let geminiQuotaExceeded = false;

// Gemini APIの設定
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Gemini System Instruction（共通の人格・ルール設定）
const TRANSLATION_SYSTEM_INSTRUCTION = `あなたは高精度な多言語翻訳AIです。

【翻訳の基本ルール】
1. 原文の意味を正確に翻訳する
2. 改行を含むテキストも正確に翻訳し、改行を保持する
3. 原文にない句読点（？！。など）を勝手に追加しない
4. 原文の句読点や記号を正確に保持する
5. LINEレンジャーのグループLINEで翻訳機能を使います

【絵文字の扱い】
1. Unicode絵文字（😊🎉❤️など）はそのまま保持し、翻訳や変換をしない
2. 絵文字を「(emoji)」「（絵文字）」「(이모지)」「(表情符號)」などのテキストに変換しない
3. 翻訳結果に「(emoji)」「(絵文字)」「(이모지)」「(表情符號)」などのテキストを含めない
4. LINE絵文字のテキスト表現（例：(moon smirk)、(brown)、(sally)など）は翻訳結果に含めない
5. 括弧で囲まれたテキスト (xxx) の形式はLINE絵文字なので、翻訳結果から除外する

【出力形式】
1. JSON形式で結果を返す場合、厳密にJSON構造を守る
2. マークダウンのコードブロック記号（\`\`\`）は使用しない
3. JSON以外の余計な文字を含めない`;

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
  console.log(`言語判定用にテキストをクリーニング: "${text}" -> "${cleanedText}"`);

  // クリーニング後のテキストが空になった場合は元のテキストを使用
  const textForDetection = cleanedText.length > 0 ? cleanedText : text;

  // 1. 短文や特殊ケースは自前ロジック
  if (textForDetection.length < 10) {
    console.log('短文のため自前ロジックを使用');
    return detectLanguageFromText(textForDetection);
  }

  // 2. 長文はfrancで高精度検出（francが読み込まれている場合のみ）
  if (franc) {
    try {
      const detected = franc(textForDetection, { minLength: 3 });
      console.log(`Francによる検出結果: ${detected}`);
      
      const languageMap = {
        'jpn': 'ja',
        'kor': 'ko', 
        'cmn': 'zh', // 中国語として扱う
        'zho': 'zh', // 中国語として扱う
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
  return detectLanguageFromText(textForDetection);
}

// Gemini APIを使用して言語判定と一括翻訳を同時に行う関数
async function translateWithGeminiBatchAndDetect(text, groupId = null) {
  try {
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.5-flash-lite',
      systemInstruction: TRANSLATION_SYSTEM_INSTRUCTION
    });
    
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
    
    const prompt = `以下のテキストの言語を判定し、適切な言語に翻訳してください。

対象言語：${targetLanguageDescription}

タスク：
1. 入力テキストの言語を判定
   - @メンション（例: @ユーザー名）や中国語の人名は無視し、実際のメッセージ内容のみで判定してください
   - ひらがな・カタカナが含まれている場合は日本語と判定してください
   - ハングルが含まれている場合は韓国語と判定してください
   - メッセージ全体の文脈を考慮して判定してください
2. その言語以外の対象言語すべてに翻訳
3. 言語コードは厳密に以下のみ使用: ja, ko, en, fr, zh-TW
4. 台湾語（繁体字中国語）は必ず "zh-TW" のみ使用
5. 各言語につき1つの翻訳のみ提供

重要な注意事項：
- 「@毛沢東 こんにちは」のような場合、@毛沢東は無視し、「こんにちは」の部分で言語判定すること
- ひらがなが含まれていれば日本語と判定すること
- メンションや人名に含まれる漢字に惑わされないこと

出力形式（JSON）：
{
  "detected_language": "ja",
  "translations": {
    "en": "English translation",
    "zh-TW": "中文翻譯"
  }
}

翻訳対象テキスト：
${escapedText}`;
    
    console.log('Gemini言語判定+一括翻訳を実行中...');
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const responseText = response.text().trim();
    
    console.log('Gemini APIレスポンス:', responseText);
    console.log('レスポンス長:', responseText.length);
    
    // JSONをパース
    try {
      let cleanedText = responseText.replace(/```json\s*/, '').replace(/```\s*$/, '');
      cleanedText = cleanedText.trim();
      console.log('クリーンアップ後のテキスト:', cleanedText);
      
      const result = JSON.parse(cleanedText);
      
      if (result.detected_language && result.translations) {
        console.log(`AI言語判定結果: ${result.detected_language}`);
        
        // Geminiが返すキーを統一（zh, zh-CN -> zh-TW）
        const normalizedTranslations = {};
        console.log('正規化前の翻訳結果:', result.translations);
        
        for (const [key, value] of Object.entries(result.translations)) {
          let normalizedKey = key;
          // 中国語の各種バリエーションをzh-TWに統一
          if (key === 'zh' || key === 'zh-CN' || key === 'zh-Hans' || key === 'zh-Hant') {
            console.log(`言語コード正規化: ${key} -> zh-TW`);
            normalizedKey = 'zh-TW';
          }
          
          // 既に同じキーが存在する場合は、より短い（一般的な）翻訳を優先
          if (normalizedTranslations[normalizedKey]) {
            console.log(`重複キー検出: ${normalizedKey}, 既存: "${normalizedTranslations[normalizedKey]}", 新規: "${value}"`);
            if (value.length < normalizedTranslations[normalizedKey].length) {
              console.log('より短い翻訳を採用');
              normalizedTranslations[normalizedKey] = value;
            } else {
              console.log('既存の翻訳を維持');
            }
          } else {
            normalizedTranslations[normalizedKey] = value;
          }
        }
        
        console.log('正規化後の翻訳結果:', normalizedTranslations);
        
        // detected_languageも正規化
        let normalizedSourceLang = result.detected_language;
        if (result.detected_language === 'zh' || result.detected_language === 'zh-CN' || 
            result.detected_language === 'zh-Hans' || result.detected_language === 'zh-Hant') {
          console.log(`ソース言語コード正規化: ${result.detected_language} -> zh-TW`);
          normalizedSourceLang = 'zh-TW';
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
              console.log(`ソース言語コード正規化: ${result.detected_language} -> zh-TW`);
              normalizedSourceLang = 'zh-TW';
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
    console.error('Gemini API言語判定+翻訳エラー:', error);
    
    // クォータエラーの場合はフラグを設定
    if (isQuotaError(error)) {
      console.log('Geminiクォータエラーを検出、フラグを設定');
      geminiQuotaExceeded = true;
    }
    
    return null;
  }
}

// Gemini APIを使用して一括翻訳する関数（フォールバック用）
async function translateWithGeminiBatch(text, targetLanguages) {
  // クォータエラーが発生している場合はスキップ
  if (geminiQuotaExceeded) {
    console.log('Geminiクォータエラーのため一括翻訳をスキップ');
    return null;
  }
  
  try {
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.5-flash-lite',
      systemInstruction: TRANSLATION_SYSTEM_INSTRUCTION
    });
    
    const languageNames = {
      'ja': '日本語',
      'ko': '한국어', 
      'en': 'English',
      'fr': 'Français',
      'th': 'ภาษาไทย',
      'zh-TW': '繁體中文'
    };
    
    // 対象言語のリストを作成
    const targetLangList = targetLanguages.map(lang => languageNames[lang]).join('、');
    
    // 改行を含むテキストをJSON文字列として安全にエスケープ
    const escapedText = JSON.stringify(text);
    
    const prompt = `以下のテキストを${targetLangList}に翻訳してください。

出力形式（JSON）：
{${targetLanguages.map(lang => `"${lang}": "翻訳結果"`).join(', ')}}

翻訳対象テキスト：
${escapedText}`;
    
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
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.5-flash-lite',
      systemInstruction: TRANSLATION_SYSTEM_INSTRUCTION
    });
    
    const languageNames = {
      'ja': '日本語',
      'ko': '한국어',
      'en': 'English',
      'fr': 'Français',
      'th': 'ภาษาไทย',
      'zh': '中文'
    };
    
    const prompt = `以下のテキストを${languageNames[targetLang]}に翻訳してください。翻訳結果のみを返してください。

翻訳対象テキスト：
${text}`;
    
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
    
    console.log(`DeepL言語コード変換: ${targetLang} -> ${deeplTargetLang}`);
    
    const params = new URLSearchParams();
    params.append('auth_key', DEEPL_API_KEY);
    params.append('text', text);
    params.append('target_lang', deeplTargetLang);
    
    console.log('DeepL APIに送信するパラメータ:');
    console.log('- text:', text);
    console.log('- target_lang:', deeplTargetLang);
    console.log('- auth_key:', DEEPL_API_KEY ? '設定済み' : '未設定');
    
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
    console.error('DeepL APIエラー詳細:', error.response?.data);
    console.error('DeepL APIステータス:', error.response?.status);
    console.error('DeepL APIヘッダー:', error.response?.headers);
    return null;
  }
}

// 翻訳を試行する関数（Gemini -> DeepLの順）
async function translateText(text, targetLang) {
  console.log(`=== 翻訳開始: "${text}" -> ${targetLang} ===`);
  
  // まずGeminiで試行
  console.log(`Geminiで翻訳を試行: ${text} -> ${targetLang}`);
  let result = await translateWithGemini(text, targetLang);
  
  if (result) {
    console.log('Geminiでの翻訳が成功');
    return result;
  }
  
  // Geminiが失敗した場合はDeepLをフォールバック
  console.log(`Geminiが失敗、DeepLをフォールバックとして使用: ${text} -> ${targetLang}`);
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
  console.log(`入力テキスト（デバッグ用）: ${JSON.stringify(text)}`);
  const aiResult = await translateWithGeminiBatchAndDetect(text, groupId);
  
  console.log('aiResult:', aiResult);
  console.log('aiResult type:', typeof aiResult);
  
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
  
  // 翻訳結果を追加（最大3つまでに制限してメッセージサイズを抑制）
  const translationEntries = Object.entries(translations).slice(0, 3);
  
  translationEntries.forEach(([lang, text]) => {
    const truncatedText = truncateText(text, 300); // 各翻訳を300文字以内に制限
    
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
    
    // リクエストボディの詳細ログ
    console.log('リクエストボディ:', JSON.stringify(req.body, null, 2));
    console.log('リクエストヘッダー:', JSON.stringify(req.headers, null, 2));
    
    if (!req.body) {
      console.error('リクエストボディが空です');
      return res.status(400).json({ error: 'Request body is empty' });
    }
    
    if (!req.body.events || !Array.isArray(req.body.events)) {
      console.log('イベントがありません');
      return res.status(200).json({ message: 'No events found' });
    }
    
    if (req.body.events.length === 0) {
      console.log('イベント配列が空です');
      return res.status(200).json({ message: 'Empty events array' });
    }

    await Promise.all(
      req.body.events.map(async (event, index) => {
        try {
          console.log(`=== イベント ${index + 1} 処理開始 ===`);
          console.log('イベント詳細:', JSON.stringify(event, null, 2));
          
          if (event.type !== 'message') {
            console.log(`イベント ${index + 1}: メッセージイベントではありません (${event.type})`);
            return;
          }
          
          if (!event.message) {
            console.log(`イベント ${index + 1}: メッセージオブジェクトがありません`);
            return;
          }
          
          if (event.message.type !== 'text') {
            console.log(`イベント ${index + 1}: テキストメッセージではありません (${event.message.type})`);
            return;
          }
          
          // グループチャットのみに制限
          if (event.source.type !== 'group') {
            console.log(`イベント ${index + 1}: グループチャット以外のメッセージのため処理をスキップ (${event.source.type})`);
            return;
          }
          
          // グループIDをログに出力
          const groupId = event.source.groupId;
          console.log(`イベント ${index + 1}: グループID = ${groupId}`);
          
          const text = event.message.text.trim();
          console.log(`イベント ${index + 1}: メッセージテキスト = "${text}"`);
          
          // replyTokenの存在確認
          if (!event.replyToken) {
            console.error(`イベント ${index + 1}: replyTokenがありません`);
            return;
          }
          console.log(`イベント ${index + 1}: replyToken = ${event.replyToken}`);
          
          // 空のメッセージは無視
          if (!text) {
            console.log(`イベント ${index + 1}: 空のメッセージのためスキップ`);
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
          console.log(`テキスト長: ${text.length}文字`);
          console.log(`改行を含む: ${text.includes('\n') ? 'はい' : 'いいえ'}`);
          if (text.includes('\n')) {
            console.log(`改行数: ${(text.match(/\n/g) || []).length}`);
            console.log(`行に分割: ${JSON.stringify(text.split('\n'))}`);
          }
          
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
          
          try {
            await client.replyMessage(event.replyToken, replyMessage);
            console.log('メッセージ送信成功');
          } catch (replyError) {
            console.error('メッセージ送信エラー:', replyError);
            console.error('エラー詳細:', {
              status: replyError.response?.status,
              statusText: replyError.response?.statusText,
              data: replyError.response?.data,
              headers: replyError.response?.headers
            });
            // フォールバックメッセージは送信せず、エラーログのみ出力
            console.log('翻訳は成功しましたが、メッセージ送信に失敗しました');
          }
          
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
