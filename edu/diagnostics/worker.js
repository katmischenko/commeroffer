const ALLOWED_ORIGIN = "https://katmischenko.github.io";
const MAX_BODY = 64 * 1024;

function cors(origin) {
  const allowed = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
function clean(value, max = 300) {
  return String(value ?? "").trim().slice(0, max);
}
function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
async function sendTelegram(env, text) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.OWNER_CHAT_ID,
      text,
      disable_web_page_preview: true
    })
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error("Telegram delivery failed");
}
function formatTelegram(p) {
  const lines = [
    "🧭 НОВАЯ ДИАГНОСТИКА MISCHENKO EDU",
    `Ученик: ${p.studentName}`,
    `Класс: ${p.studentClass}`,
    `Направление: ${p.direction}`,
    p.experience ? `Опыт: ${p.experience}` : "",
    `Результат: ${p.score}/${p.maxScore} (${p.percentage}%)`,
    `Дата: ${p.completedAt}`,
    "",
    "ТЕМЫ ДЛЯ ВНИМАНИЯ:",
    ...(p.weakTopics.length ? p.weakTopics.map(x => "• " + x) : ["Нет отмеченных слабых тем"]),
    "",
    "ПОЛНЫЙ ОТЧЁТ:"
  ];
  for (const [index, a] of p.answers.entries()) {
    lines.push(
      `${index + 1}. ${a.question}`,
      `Ответ: ${a.answerText || "Не отвечено"}`,
      `Правильный ответ: ${a.correctText}`,
      `Статус: ${a.statusLabel}`,
      `Тема: ${a.topic} | Сложность: ${a.difficulty}`,
      `Уверенность: ${a.confidenceLabel || "не указана"}`,
      `Разбор: ${a.explanation}`,
      ""
    );
  }
  return lines.filter(Boolean).join("\n").slice(0, 3900);
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return json({ ok: true, service: "Mischenko Edu diagnostics", database: !!env.DB }, 200, origin);
    }
    if (request.method === "POST" && url.pathname === "/diagnostics") {
      if (origin && origin !== ALLOWED_ORIGIN) return json({ ok: false, error: "origin_not_allowed" }, 403, origin);
      const type = request.headers.get("Content-Type") || "";
      if (!type.includes("application/json")) return json({ ok: false, error: "json_required" }, 415, origin);
      const raw = await request.text();
      if (raw.length > MAX_BODY) return json({ ok: false, error: "payload_too_large" }, 413, origin);
      let p;
      try { p = JSON.parse(raw); } catch { return json({ ok: false, error: "invalid_json" }, 400, origin); }
      if (p.website) return json({ ok: false, error: "spam_rejected" }, 400, origin);
      if (p.consent !== true) return json({ ok: false, error: "consent_required" }, 400, origin);
      if (!clean(p.studentName, 100) || !clean(p.studentClass, 10) || !clean(p.direction, 60)) {
        return json({ ok: false, error: "required_fields_missing" }, 400, origin);
      }
      if (!Array.isArray(p.answers) || p.answers.length !== 15) {
        return json({ ok: false, error: "exactly_15_answers_required" }, 400, origin);
      }
      if (!env.BOT_TOKEN || !env.OWNER_CHAT_ID || !env.DB) {
        return json({ ok: false, error: "service_not_configured" }, 503, origin);
      }
      const attemptId = clean(p.attemptId, 80);
      if (!/^[a-zA-Z0-9_-]{12,80}$/.test(attemptId)) return json({ ok: false, error: "invalid_attempt_id" }, 400, origin);
      const score = Number(p.score);
      const maxScore = Number(p.maxScore);
      if (!Number.isInteger(score) || !Number.isInteger(maxScore) || maxScore !== 15 || score < 0 || score > maxScore) {
        return json({ ok: false, error: "invalid_score" }, 400, origin);
      }
      const payload = {
        attemptId,
        studentName: clean(p.studentName, 100),
        studentClass: clean(p.studentClass, 10),
        direction: clean(p.direction, 60),
        experience: clean(p.experience, 60),
        score,
        maxScore,
        percentage: Math.round(score / maxScore * 100),
        completedAt: clean(p.completedAt, 50) || new Date().toISOString(),
        weakTopics: Array.isArray(p.weakTopics) ? p.weakTopics.slice(0, 20).map(x => clean(x, 100)) : [],
        answers: p.answers.map(a => ({
          question: clean(a.question, 700),
          answerText: clean(a.answerText, 300),
          correctText: clean(a.correctText, 300),
          status: clean(a.status, 20),
          statusLabel: clean(a.statusLabel, 40),
          topic: clean(a.topic, 100),
          difficulty: clean(a.difficulty, 30),
          confidenceLabel: clean(a.confidenceLabel, 40),
          explanation: clean(a.explanation, 500)
        }))
      };
      try {
        await env.DB.prepare(`INSERT OR IGNORE INTO diagnostic_attempts
          (attempt_id, student_name, student_class, direction, experience, score, max_score, percentage, completed_at, payload_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(payload.attemptId, payload.studentName, payload.studentClass, payload.direction,
            payload.experience, payload.score, payload.maxScore, payload.percentage,
            payload.completedAt, JSON.stringify(payload)).run();
        const row = await env.DB.prepare("SELECT attempt_id FROM diagnostic_attempts WHERE attempt_id = ?")
          .bind(attemptId).first();
        if (!row) throw new Error("Database save failed");
      } catch (e) {
        return json({ ok: false, error: "database_save_failed" }, 500, origin);
      }
      let telegramSent = false;
      try {
        await sendTelegram(env, formatTelegram(payload));
        telegramSent = true;
      } catch (e) {
        // The attempt is already safely stored; it can be retried from the admin archive.
      }
      return json({ ok: true, saved: true, telegramSent, attemptId }, 200, origin);
    }
    if (request.method === "GET" && url.pathname === "/admin/attempts") {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!safeEqual(token, env.ADMIN_TOKEN)) return json({ ok: false, error: "unauthorized" }, 401, origin);
      if (!env.DB) return json({ ok: false, error: "database_not_configured" }, 503, origin);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const rows = await env.DB.prepare(
        "SELECT attempt_id, student_name, student_class, direction, experience, score, max_score, percentage, completed_at, payload_json FROM diagnostic_attempts ORDER BY completed_at DESC LIMIT ?"
      ).bind(limit).all();
      return json({ ok: true, attempts: rows.results || [] }, 200, origin);
    }
    return json({ ok: false, error: "not_found" }, 404, origin);
  }
};
