// lib/rateLimit.js
// Rate limiter بسيط بالذاكرة (in-memory) يحمي /api/turn و/api/analyze و/api/plan
// من الاستدعاء المباشر بلا حدود واستنزاف GEMINI_API_KEY.
// ملاحظة: على Vercel كل instance له ذاكرته الخاصة، فالحماية على مستوى
// الـ instance مو موزعة بالكامل — إذا احتجت حماية أقوى لاحقًا استخدم
// Upstash/Redis. بس هذا كافٍ يوقف إساءة الاستخدام المباشرة العادية.

const buckets = new Map();
const WINDOW_MS = 60 * 1000; // نافذة دقيقة وحدة
const MAX_REQUESTS = 12;     // أقصى عدد طلبات لكل IP بالنافذة

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function checkRateLimit(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  let bucket = buckets.get(ip);

  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    buckets.set(ip, bucket);
  }

  bucket.count++;

  if (buckets.size > 5000) {
    for (const [key, b] of buckets) {
      if (now - b.windowStart > WINDOW_MS) buckets.delete(key);
    }
  }

  return bucket.count <= MAX_REQUESTS;
}

module.exports = { checkRateLimit };
