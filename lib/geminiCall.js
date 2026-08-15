// lib/geminiCall.js
// مساعد موحّد لاستدعاء Gemini API (generateContent) يستخدمه api/turn.js و
// api/analyze.js و api/plan.js.
//
// طبقات حماية من "high demand" / أخطاء مؤقتة ومشاكل توافق بين عائلات النماذج:
// 1) إعادة محاولة (retry + backoff) على نفس النموذج للأخطاء المؤقتة (429/500/503).
// 2) لو نفس النموذج فاضل مزدحم أو غير متوافق، يتحول تلقائيًا لنموذج مجاني ثاني
//    من نفس المفتاح (fallback) بدل ما يطلع الخطأ للمستخدم مباشرة.
// 3) كل محاولة استدعاء محدودة بـ timeout صريح عشان ما تتراكم استدعاءات معلّقة
//    وتاكل وقت التنفيذ المسموح لدالة Vercel (30 ثانية حسب vercel.json).

const RETRYABLE_STATUS = new Set([429, 500, 503]); // أخطاء مؤقتة يستاهل نعيد المحاولة فيها على نفس النموذج

// أخطاء "حرجة" متوقع تتكرر بنفس الشكل على أي نموذج بنفس المفتاح (مفتاح API
// غير صالح أو ممنوع) — ما فيه فايدة نجرب نموذج ثاني معها، نوقف على طول.
const HARD_STOP_STATUS = new Set([401, 403]);

// عدد محاولات إضافية على نفس النموذج قبل ما ننتقل للي بعده
const RETRIES_PER_MODEL = 1;
const BASE_DELAY_MS = 700;

// مهلة صريحة لكل محاولة استدعاء (مللي ثانية). بدونها استدعاء واحد معلّق
// (مشكلة شبكة مثلاً) يقدر ياكل كل وقت تنفيذ دالة Vercel المسموح بدون ما
// تنتقل السلسلة لنموذج بديل أصلاً.
const FETCH_TIMEOUT_MS = 15000;

// سلسلة النماذج المجانية البديلة (كلها Flash/Flash-Lite — النماذج المتاحة
// مجانًا بـGoogle AI Studio). ينتقل لها بالترتيب لو النموذج الأساسي فشل.
// تقدر تتحكم فيها عبر متغير بيئة GEMINI_FALLBACK_MODELS مفصول بفواصل،
// بدون ما تلمس الكود، مثال: "gemini-2.5-flash,gemini-3.1-flash-lite"
const DEFAULT_FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite'
];

function getFallbackModels(primaryModel) {
  const configured = (process.env.GEMINI_FALLBACK_MODELS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const list = configured.length ? configured : DEFAULT_FALLBACK_MODELS;
  // ما نكرر النموذج الأساسي لو كان موجود بالقائمة صدفة
  return list.filter(m => m !== primaryModel);
}

// نماذج عائلة 2.5 (gemini-2.5-*) ما تدعم thinkingLevel إطلاقًا — تحتاج
// thinkingBudget (رقم tokens) بدلها، وترجع خطأ 400 لو استلمت thinkingLevel.
// نماذج عائلة 3.x وما بعدها (gemini-3-*, gemini-3.1-*, gemini-3.5-*, ...)
// تستخدم thinkingLevel. هذي الدالة تبني الإعداد الصح حسب اسم الموديل نفسه،
// عشان سلسلة الـ fallback ما تنكسر لما تنتقل بين العائلتين.
function getThinkingConfig(model) {
  const is25Family = /^gemini-2\.5/.test(model);
  if (is25Family) {
    // ما فيه مستوى "low" رسمي بعائلة 2.5 — استخدمنا budget صغير كمكافئ
    // عملي (بدل تعطيل التفكير كليًا) عشان نحافظ على جودة قريبة من الأساسي.
    return { thinkingBudget: 1024 };
  }
  // عائلة 3.x وما بعدها (وهو الافتراض الآمن لأي اسم موديل جديد لسا ما أضفناه)
  return { thinkingLevel: 'low' };
}

// يبني generationConfig نهائي لموديل معيّن: ياخذ الإعدادات المشتركة
// (maxOutputTokens, responseMimeType, ...) زي ما هي، ويستبدل thinkingConfig
// فقط بالمناسب لعائلة هذا الموديل تحديدًا.
function buildGenerationConfigForModel(model, baseGenerationConfig) {
  const { thinkingConfig, ...rest } = baseGenerationConfig || {};
  return { ...rest, thinkingConfig: getThinkingConfig(model) };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// يحاول نموذج واحد بس، مع إعادة محاولة محدودة (RETRIES_PER_MODEL) بتأخير
// متصاعد، ومهلة زمنية صريحة (FETCH_TIMEOUT_MS) على كل محاولة.
async function tryModel({ apiKey, model, systemPrompt, userText, generationConfig }) {
  let lastStatus = 500;
  let lastData = null;
  const modelGenerationConfig = buildGenerationConfigForModel(model, generationConfig);

  for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
    let geminiRes;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            generationConfig: modelGenerationConfig
          }),
          signal: controller.signal
        }
      );
    } catch (networkErr) {
      const isTimeout = networkErr.name === 'AbortError';
      if (attempt < RETRIES_PER_MODEL) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      return {
        ok: false,
        status: 502,
        data: { error: { message: isTimeout ? `Gemini request timed out after ${FETCH_TIMEOUT_MS}ms` : networkErr.message } },
        modelUsed: model
      };
    } finally {
      clearTimeout(timeoutId);
    }

    const data = await geminiRes.json().catch(() => null);

    if (geminiRes.ok) {
      return { ok: true, status: geminiRes.status, data, modelUsed: model };
    }

    lastStatus = geminiRes.status;
    lastData = data;

    if (RETRYABLE_STATUS.has(geminiRes.status) && attempt < RETRIES_PER_MODEL) {
      await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
      continue;
    }

    return { ok: false, status: lastStatus, data: lastData, modelUsed: model };
  }

  return { ok: false, status: lastStatus, data: lastData, modelUsed: model };
}

/**
 * ينادي Gemini generateContent مع إعادة محاولة على نفس النموذج، ولو فشل
 * بالكامل ينتقل تلقائيًا لنموذج مجاني بديل من نفس المفتاح — ما عدا لو كان
 * الخطأ من نوع يتكرر بالتأكيد على كل نموذج (401/403).
 * يرجع { ok, status, data, modelUsed } — modelUsed يفيدك لو تبي تعرف أي
 * نموذج فعليًا رد (تقدر تتجاهله لو ما تحتاجه).
 */
async function callGeminiWithRetry({ apiKey, model, systemPrompt, userText, generationConfig }) {
  const modelsToTry = [model, ...getFallbackModels(model)];

  let result = null;
  for (const candidateModel of modelsToTry) {
    result = await tryModel({ apiKey, model: candidateModel, systemPrompt, userText, generationConfig });
    if (result.ok) return result;

    if (HARD_STOP_STATUS.has(result.status)) return result;

    // أي شي ثاني (بما فيها 400 — غالبًا تعارض باراميتر خاص بموديل معيّن،
    // مو بالضرورة خطأ بالمحتوى نفسه) نكمل نجرب الموديل التالي بالقائمة.
  }

  return result;
}

// ينظّف رد Gemini النصي (يشيل ```json fences إن وجدت) ويحاول يحوّله JSON.
// يرمي خطأ عادي لو فشل التحويل — لفّها بـ try/catch بالـ endpoint اللي يناديها.
function parseGeminiJson(data) {
  const candidate = data.candidates && data.candidates[0];
  const textOut = (candidate && candidate.content &&
    candidate.content.parts && candidate.content.parts[0] &&
    candidate.content.parts[0].text) || '';
  const clean = textOut.replace(/```json/g, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(clean); // يرمي خطأ عادي لو فشل — يمسكه المتصل
  return { parsed, candidate, textOut };
}

module.exports = { callGeminiWithRetry, parseGeminiJson };
