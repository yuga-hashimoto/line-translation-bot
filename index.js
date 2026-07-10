const line = require('@line/bot-sdk');
const axios = require('axios');
const express = require('express');
const { Redis } = require('@upstash/redis');

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

const { createTranslationProvider } = require('./lib/translationProvider');

const translationProvider = createTranslationProvider();
const ACTIVE_MODEL = translationProvider.model;

console.log(`Translation provider: ${translationProvider.name}`);
console.log(`Translation model: ${ACTIVE_MODEL || 'unconfigured'}`);

// Translation System Instruction
const TRANSLATION_SYSTEM_INSTRUCTION = `You are a high-precision multilingual translation AI for a LINE group chat.

Core Rules:
1. Translate accurately, preserving line breaks and original punctuation. Do NOT add new punctuation.
2. Handling Mentions: Keep "@username" exactly as is. Example: "Hi @John" -> "Hi @John".
3. Handling Emojis: Keep all Unicode emojis (😊) as-is. Do NOT output text descriptions like "(emoji)".
4. Output Format: Return ONLY a valid JSON object. No markdown markers (\`\`\`).`;

// DeepL APIの設定（フォールバック用）
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
const DEEPL_API_URL = 'https://api-free.deepl.com/v2/translate';

// Upstash Redisの設定（ログ保存用）
let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  console.log('Upstash Redis initialized for logging');
} else {
  console.log('Upstash Redis not configured - logging disabled');
}

// Upstash Redisの設定（rangers-api と共有、line:known-members 書き込み用）
const rangersRedis = new Redis({
  url: process.env.RANGERS_UPSTASH_URL,
  token: process.env.RANGERS_UPSTASH_TOKEN,
});

const client = new line.Client(config);

// クォータエラーかどうかを判定する関数
function isQuotaError(error) {
  return error.message && error.message.includes('429 Too Many Requests') &&
    error.message.includes('quota');
}

// LINEメンバー情報を line:known-members に保存する関数（バッチ処理）
async function saveGroupMemberInfoBatch(userIds, groupId) {
  if (userIds.size === 0) return;
  try {
    const raw = await rangersRedis.get('line:known-members');
    const members = raw
      ? (typeof raw === 'object' ? raw : JSON.parse(raw))
      : {};

    let isUpdated = false;
    for (const userId of userIds) {
      // 同じグループIDですでに保存済みのユーザーはスキップ
      if (members[userId] && members[userId].groupId === groupId) continue;
      try {
        const profile = await client.getGroupMemberProfile(groupId, userId);
        members[userId] = {
          userId,
          displayName: profile.displayName,
          pictureUrl: profile.pictureUrl || null,
          groupId,
          updatedAt: Date.now(),
        };
        isUpdated = true;
        console.log(`👤 プロフィール保存: [グループ: ${groupId}] ${profile.displayName} (${userId})`);
      } catch {
        // ボット自身や取得不可のユーザーは無視
      }
    }

    if (isUpdated) {
      await rangersRedis.set('line:known-members', JSON.stringify(members));
    }
  } catch (err) {
    console.error(`[saveGroupMemberInfoBatch]:`, err.message);
  }
}

// 翻訳ログを保存する関数
async function saveTranslationLog(logData) {
  if (!redis) {
    return; // Redisが設定されていない場合はスキップ
  }

  try {
    const logId = `translation:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;

    const log = {
      id: logId,
      timestamp: new Date().toISOString(),
      groupId: logData.groupId,
      originalText: logData.originalText,
      detectedLanguage: logData.detectedLanguage,
      translations: logData.translations,
      model: logData.model,
      processingTimeMs: logData.processingTimeMs,
    };

    // 30日間保持（TTL: 2592000秒）
    await redis.set(logId, JSON.stringify(log), { ex: 2592000 });

    // 最新1000件のログIDをリストで管理
    await redis.lpush('translation:logs', logId);
    await redis.ltrim('translation:logs', 0, 999);

    console.log(`[Log] Saved: ${logId}`);
  } catch (error) {
    console.error('[Log] Save error:', error.message);
  }
}

// 翻訳前の前処理：不要な要素を除去する関数
// - LINE絵文字テキスト: (moon furious), (resentful face), (brown), (cony) など
// - 先頭のメンション: @ユーザー名（文頭に連なるメンションのみ除去、文中のメンションは保持）
function cleanTextForTranslation(text) {
  if (!text) return text;

  let cleaned = text;

  // 先頭のメンションのみ除去（文頭に連なるメンションを削除）
  // 文中のメンションはそのまま保持（AIが翻訳時にスキップする）
  cleaned = cleaned.replace(/^(@[^\s]+\s*)+/g, '');

  // LINE絵文字テキストパターン: 既知のLINE絵文字キャラクター名と2語以上の組み合わせ
  // brown, cony, sally, moon, james などのキャラクター名や、moon furious などの組み合わせ
  const lineEmojiPattern = /\((brown|cony|sally|moon|james|jessica|boss|choco|leonard|edward|pangyo|ninja|muzi|apeach|frodo|neo|tube|ryan|con|jay-g|chopper)(?:\s+[a-z]+)*\)/gi;
  const multiWordPattern = /\([a-z]+\s+[a-z]+(?:\s+[a-z]+)*\)/gi;
  cleaned = cleaned.replace(lineEmojiPattern, '').replace(multiWordPattern, '');

  // 余分な空白を整理（改行は保持）
  // [^\S\n]+ は改行以外の空白文字にマッチ
  return cleaned.replace(/[^\S\n]+/g, ' ').replace(/\n+/g, '\n').trim();
}

// 後方互換性のためのエイリアス
function removeLineEmojiText(text) {
  return cleanTextForTranslation(text);
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
  if (!translationProvider.isReady) {
    console.error(`Translation provider ${translationProvider.name} is not initialized.`);
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

    // Create list of target languages (excluding the original language) - purely for display/context in prompt if needed,
    // but the schema approach handles it better dynamically.

    const prompt = `Identify the language of the text below and provide translations in JSON format.

Input Text: ${escapedText}

Target schema:
{
  "detected_language": "Detected language code (available codes: ${availableLanguages.join(', ')})",
  "translations": {
    "target_lang_code": "Translated text"
  }
}

Requirements:
1. Detect language from content (ignore mentions/names).
2. Translate to ALL supported languages (${availableLanguages.join(', ')}) EXCEPT the detected language.
3. ${groupId === FRENCH_ONLY_GROUP_ID ? 'Support French (fr) as a target language.' : '"zh-TW" stands for Traditional Chinese (Taiwanese).'}
4. Return ONLY the JSON object.

Example (if Input is Japanese):
{
  "detected_language": "ja",
  "translations": {
    ${groupId === FRENCH_ONLY_GROUP_ID ? '"fr": "...", "en": "...", "zh-TW": "..."' : '"ko": "...", "zh-TW": "...", "en": "..."'}
  }
}`;

    const messages = [
      { role: 'system', content: TRANSLATION_SYSTEM_INSTRUCTION },
      { role: 'user', content: prompt },
    ];
    const completion = await translationProvider.createChatCompletion(messages);

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

        // 実際に使用されたモデルを返す
        const usedModel = completion.model || ACTIVE_MODEL;

        return {
          sourceLang: normalizedSourceLang,
          translations: normalizedTranslations,
          model: usedModel
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

            // 実際に使用されたモデルを返す
            const usedModel = completion.model || ACTIVE_MODEL;

            return {
              sourceLang: normalizedSourceLang,
              translations: normalizedTranslations,
              model: usedModel
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
  if (!translationProvider.isReady) {
    console.error(`Translation provider ${translationProvider.name} is not initialized.`);
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

    const messages = [
      { role: 'system', content: TRANSLATION_SYSTEM_INSTRUCTION },
      { role: 'user', content: prompt },
    ];
    const completion = await translationProvider.createChatCompletion(messages);

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
  if (!translationProvider.isReady) {
    console.error(`Translation provider ${translationProvider.name} is not initialized.`);
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

    const messages = [
      { role: 'system', content: TRANSLATION_SYSTEM_INSTRUCTION },
      { role: 'user', content: prompt },
    ];
    const completion = await translationProvider.createChatCompletion(messages);

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
      translations: aiResult.translations,
      model: aiResult.model
    };
  }

  // AIが失敗した場合はフォールバック（従来の方式）
  const sourceLang = await detectLanguage(text);
  const translations = await translateToMultipleLanguages(text, sourceLang, groupId);

  return {
    sourceLang: sourceLang,
    translations: translations,
    model: 'fallback'
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

  const contents = [];

  // 翻訳結果を追加（すべての翻訳を表示）
  const translationEntries = Object.entries(translations);

  translationEntries.forEach(([lang, text], index) => {
    const truncatedText = truncateText(text, 1500); // 各翻訳を1500文字以内に制限

    if (index > 0) {
      contents.push({
        type: 'separator',
        margin: 'md'
      });
    }

    contents.push(
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
    const fallbackText = `${Object.entries(translations).map(([lang, text]) =>
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

          // LINEメンバー情報の蓄積（送信者＋メンション対象、バッチ処理）
          const userIdsToFetch = new Set();
          if (event.source.userId) {
            userIdsToFetch.add(event.source.userId);
          }
          const mentionees = event.message.mention?.mentionees || [];
          for (const mentionee of mentionees) {
            if (mentionee.userId && mentionee.userId !== 'all') {
              userIdsToFetch.add(mentionee.userId);
            }
          }
          saveGroupMemberInfoBatch(userIdsToFetch, groupId).catch(() => {});

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

          // LINE絵文字テキストを除去（翻訳前の前処理）
          const textForTranslation = removeLineEmojiText(text);

          // 前処理後にテキストが空になった場合はスキップ
          if (!textForTranslation) {
            return;
          }

          console.log(`[Translation] Text: "${textForTranslation}" | Provider: ${translationProvider.name} | Model: ${ACTIVE_MODEL}`);

          // 翻訳実行前の時刻を記録
          const startTime = Date.now();

          // AI言語判定+翻訳実行（前処理済みテキストを使用）
          const result = await translateWithAIDetection(textForTranslation, groupId);
          const sourceLang = result.sourceLang;
          const translations = result.translations;

          // 処理時間を計算
          const processingTimeMs = Date.now() - startTime;

          if (Object.keys(translations).length === 0) {
            console.error('Translation failed: empty result');
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: '翻訳に失敗しました。もう一度お試しください。'
            });
            return;
          }

          console.log(`[Translation] Detected: ${sourceLang} | Translations: ${Object.keys(translations).join(', ')} | Time: ${processingTimeMs}ms`);

          // ログ保存（非同期で実行、エラーが発生しても翻訳処理は継続）
          saveTranslationLog({
            groupId,
            originalText: text,
            detectedLanguage: sourceLang,
            translations,
            model: result.model || ACTIVE_MODEL,
            processingTimeMs,
          }).catch(err => console.error('[Log] Error:', err.message));

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

// ログ取得エンドポイント（分析用）
app.get('/logs', async (req, res) => {
  // Redisが設定されていない場合はエラー
  if (!redis) {
    return res.status(503).json({ error: 'Logging is not configured' });
  }

  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const logIds = await redis.lrange('translation:logs', 0, limit - 1);

    const logs = [];
    for (const logId of logIds) {
      const log = await redis.get(logId);
      if (log) {
        logs.push(typeof log === 'string' ? JSON.parse(log) : log);
      }
    }

    res.json({ count: logs.length, logs });
  } catch (error) {
    console.error('[Logs API] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Cloud Functions との互換性
exports.lineTranslationBot = handleWebhook;

// Cloud Run用のサーバー起動
const PORT = process.env.PORT || 8080;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}
