// lib/geminiCall.js
// مساعد موحّد لاستدعاء Gemini API (generateContent) يستخدمه api/turn.js و
// api/analyze.js و api/plan.js.
//
// ليش هذا الملف موجود:
// رسالة "This model is currently experiencing high demand" هي رد فعلي من
// جوجل (عادة HTTP 503/429) لما نموذج Gemini يكون مزدحم مؤقتًا. الكود القديم
// كان يطلع هذا الخطأ للمستخدم مباشرة من أول محاولة فاشلة بدون أي إعادة
// محاولة، مع إن هذي الأخطاء غالبًا تختفي خلال ثوانٍ لو أعدنا الطلب.
//
// هذا الملف يعيد المحاولة تلقائيًا (حتى 3 مرات إضافية) بتأخير متصاعد
// (exponential backoff: ٠.٨ث ثم ١.٦ث ثم ٣.٢ث) قبل ما يرجع الخطأ فعليًا
// للمستخدم — فمعظم حالات الازدحام المؤقت تنحل بدون ما المستخدم يشوف أي خطأ.

const RETRYABLE_STATUS = new Set([429, 500, 503]); // أخطاء مؤقتة يستاهل نعيد المحاولة فيها
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 800;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * ينادي Gemini generateContent مع إعادة محاولة تلقائية عند الأخطاء المؤقتة.
 * يرجع { ok, status, data } — نفس شكل النتيجة اللي الكود القديم كان يبنيها
 * يدويًا من geminiRes.ok / geminiRes.status / data.
 */
async function callGeminiWithRetry({ apiKey, model, systemPrompt, userText, generationConfig }) {
  let lastStatus = 500;
  let lastData = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let geminiRes;
    try {
      geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            generationConfig
          })
        }
      );
    } catch (networkErr) {
      // خطأ شبكة (ما وصل رد أصلاً) — عامله كأنه مؤقت وحاول مرة ثانية
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      return { ok: false, status: 502, data: { error: { message: networkErr.message } } };
    }

    const data = await geminiRes.json().catch(() => null);

    if (geminiRes.ok) {
      return { ok: true, status: geminiRes.status, data };
    }

    lastStatus = geminiRes.status;
    lastData = data;

    if (RETRYABLE_STATUS.has(geminiRes.status) && attempt < MAX_RETRIES) {
      await sleep(BASE_DELAY_MS * Math.pow(2, attempt)); // 800ms, 1600ms, 3200ms
      continue;
    }

    // خطأ غير قابل لإعادة المحاولة (مثلاً 400 طلب غلط) أو خلصت المحاولات
    return { ok: false, status: lastStatus, data: lastData };
  }

  return { ok: false, status: lastStatus, data: lastData };
}

module.exports = { callGeminiWithRetry };
