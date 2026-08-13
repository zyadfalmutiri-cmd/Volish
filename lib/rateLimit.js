// lib/rateLimit.js
// Rate limiter مدعوم بـ Supabase (Postgres RPC ذرّي) يحمي /api/turn و/api/analyze
// و/api/plan من الاستدعاء المباشر بلا حدود واستنزاف GEMINI_API_KEY.
//
// ملاحظة مهمة: النسخة القديمة كانت تستخدم Map بالذاكرة، وهذا غير موثوق على
// Vercel serverless لأن كل استدعاء ممكن يوصل لـ instance مختلفة (cold start).
// النسخة هذي تستخدم جدول + دالة RPC ذرّية بقاعدة Supabase (تم إنشاؤها فعليًا)،
// فتشتغل صح بغض النظر عن عدد الـ instances.

const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 12;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Allow-list للـ Origin header — طبقة حماية إضافية عشان مواقع ثانية ما
// تقدر تستدعي هذي الـ routes مباشرة من متصفح وتستنزف مفتاح Gemini.
// الطلبات بدون Origin header (server-to-server) تعدّى — طبقة حماية ناعمة،
// مو حدًا أمنيًا صارمًا. حط فيها كل نطاق فعلي يخدم هذا الفرونت.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isAllowedOrigin(req) {
  if (ALLOWED_ORIGINS.length === 0) return true; // ما تم ضبطها — تخطى هذي الطبقة
  const origin = req.headers.origin;
  if (!origin) return true; // ما فيه Origin header — نعدّي ونعتمد على الـrate limit + المفتاح
  return ALLOWED_ORIGINS.includes(origin);
}

// يرجع true لو الطلب مسموح، false لو لازم يترفض (429).
// Fails OPEN (يسمح بالطلب) لو env vars الخاصة بـ Supabase مو مضبوطة، حتى ما
// يتحول متغير بيئة ناقص لتعطل كامل — لكن لازم تضبطها.
async function checkRateLimit(req) {
  if (!isAllowedOrigin(req)) return false;

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return true; // fail-open — شوف الملاحظة فوق؛ اضبط env vars لتفعيل الحد الفعلي
  }

  const ip = getClientIp(req);

  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_and_increment_rate_limit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        p_client_ip: ip,
        p_max_requests: MAX_REQUESTS,
        p_window_seconds: WINDOW_SECONDS
      })
    });
    if (!resp.ok) return true; // fail-open لو صار خطأ من جهة Supabase
    const allowed = await resp.json();
    return allowed === true;
  } catch (e) {
    return true; // fail-open لو صار خطأ شبكة
  }
}

module.exports = { checkRateLimit };
