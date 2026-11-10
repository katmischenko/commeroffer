const ALLOWED_ORIGIN = "https://katmischenko.github.io";
const MAX_BODY = 64 * 1024;

function cors(origin) {
  const allowed = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
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
  return [
    "🧭 НОВАЯ ДИАГНОСТИКА MISCHENKO EDU",
    `Ученик: ${p.studentName}`,
    `Класс: ${p.studentClass}`,
    `Направление: ${p.direction}`,
    `Программа: ${p.curriculumName || "не указана"}`,
    p.curriculumLevel ? `Уровень: ${p.curriculumLevel}` : "",
    p.curriculumDetail ? `Уточнение: ${p.curriculumDetail}` : "",
    p.experience ? `Опыт: ${p.experience}` : "",
    `Результат: ${p.score}/${p.maxScore} (${p.percentage}%)`,
    `Дата: ${p.completedAt}`,
    `ID попытки: ${p.attemptId}`,
    "",
    "Полный разбор сохранён в закрытом архиве Mischenko Edu."
  ].filter(Boolean).join("\\n").slice(0, 3900);
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
      if (!env.DB) return json({ ok: false, error: "database_not_configured" }, 503, origin);
      const attemptId = clean(p.attemptId, 80);
      if (!/^[a-zA-Z0-9_-]{12,80}$/.test(attemptId)) return json({ ok: false, error: "invalid_attempt_id" }, 400, origin);
      const score = Number(p.score);
      const maxScore = Number(p.maxScore);
      if (!Number.isInteger(score) || !Number.isInteger(maxScore) || maxScore !== 15 || score < 0 || score > maxScore) {
        return json({ ok: false, error: "invalid_score" }, 400, origin);
      }
      const curriculumId = clean(p.curriculumId, 20);
      const curriculumName = clean(p.curriculumName, 160);
      const curriculumDetail = clean(p.curriculumDetail, 140);
      if (!["ru", "by", "other", "self"].includes(curriculumId) || !curriculumName) {
        return json({ ok: false, error: "curriculum_required" }, 400, origin);
      }
      if (curriculumId === "other" && !curriculumDetail) {
        return json({ ok: false, error: "curriculum_detail_required" }, 400, origin);
      }
      const payload = {
        attemptId,
        studentName: clean(p.studentName, 100),
        studentClass: clean(p.studentClass, 10),
        direction: clean(p.direction, 60),
        experience: clean(p.experience, 60),
        curriculumId,
        curriculumName,
        curriculumDetail,
        curriculumLevel: clean(p.curriculumLevel, 20),
        consent: true,
        consentVersion: clean(p.consentVersion, 40),
        consentAt: clean(p.consentAt, 50),
        telegramConsent: p.telegramConsent === true,
        bankProgramMatched: p.bankProgramMatched === true,
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
      let inserted = false;
      try {
        const result = await env.DB.prepare(`INSERT OR IGNORE INTO diagnostic_attempts
          (attempt_id, student_name, student_class, direction, experience, curriculum_id, curriculum_name, curriculum_detail, curriculum_level, consent_version, telegram_consent, score, max_score, percentage, completed_at, payload_json, telegram_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(payload.attemptId, payload.studentName, payload.studentClass, payload.direction,
            payload.experience, payload.curriculumId, payload.curriculumName, payload.curriculumDetail,
            payload.curriculumLevel, payload.consentVersion, payload.telegramConsent ? 1 : 0, payload.score, payload.maxScore,
            payload.percentage, payload.completedAt, JSON.stringify(payload),
            payload.telegramConsent ? "pending" : "sent").run();
        inserted = Number(result?.meta?.changes || 0) > 0;
        const row = await env.DB.prepare("SELECT attempt_id, payload_json, telegram_status, telegram_claimed_at, telegram_consent, curriculum_level FROM diagnostic_attempts WHERE attempt_id = ?")
          .bind(attemptId).first();
        if (!row) throw new Error("Database save failed");
        // On a retry, always use the immutable payload already stored for this attempt.
        if (!inserted) Object.assign(payload, JSON.parse(row.payload_json || "{}"));
      } catch (e) {
        return json({ ok: false, error: "database_save_failed" }, 500, origin);
      }
      const shouldNotify = payload.telegramConsent === true;
      if (!shouldNotify) {
        return json({
          ok: true, saved: true, duplicate: !inserted,
          telegramSent: false, telegramNotRequested: true, notificationPending: false, attemptId
        }, 200, origin);
      }
      if (!env.BOT_TOKEN || !env.OWNER_CHAT_ID) {
        return json({ ok: false, error: "telegram_not_configured", saved: true, attemptId }, 503, origin);
      }
      // Claim notification delivery atomically. A retry can reclaim a stale sending lease,
      // while successful deliveries are never sent again for the same attemptId.
      const now = new Date();
      const nowIso = now.toISOString();
      const staleBefore = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
      let claim;
      try {
        claim = await env.DB.prepare(`UPDATE diagnostic_attempts
          SET telegram_status = 'sending', telegram_claimed_at = ?
          WHERE attempt_id = ? AND (
            telegram_status = 'pending'
            OR (telegram_status = 'sending' AND telegram_claimed_at < ?)
          )`).bind(nowIso, attemptId, staleBefore).run();
      } catch (e) {
        return json({ ok: false, error: "notification_state_unavailable", saved: true, attemptId }, 503, origin);
      }
      const claimed = Number(claim?.meta?.changes || 0) > 0;
      if (!claimed) {
        const state = await env.DB.prepare("SELECT telegram_status FROM diagnostic_attempts WHERE attempt_id = ?")
          .bind(attemptId).first();
        return json({
          ok: true, saved: true, duplicate: !inserted,
          telegramSent: state?.telegram_status === "sent",
          notificationPending: state?.telegram_status !== "sent",
          attemptId
        }, 200, origin);
      }
      let telegramSent = false;
      try {
        await sendTelegram(env, formatTelegram(payload));
        telegramSent = true;
        await env.DB.prepare("UPDATE diagnostic_attempts SET telegram_status = 'sent', telegram_claimed_at = NULL WHERE attempt_id = ?")
          .bind(attemptId).run();
      } catch (e) {
        // Reset to pending so a client retry with the same attemptId can safely try again.
        await env.DB.prepare("UPDATE diagnostic_attempts SET telegram_status = 'pending', telegram_claimed_at = NULL WHERE attempt_id = ?")
          .bind(attemptId).run();
      }
      return json({
        ok: true, saved: true, duplicate: !inserted,
        telegramSent, notificationPending: !telegramSent, attemptId
      }, 200, origin);
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/admin/attempts/")) {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!safeEqual(token, env.ADMIN_TOKEN)) return json({ ok: false, error: "unauthorized" }, 401, origin);
      if (!env.DB) return json({ ok: false, error: "database_not_configured" }, 503, origin);
      const attemptId = clean(decodeURIComponent(url.pathname.slice("/admin/attempts/".length)), 80);
      if (!/^[a-zA-Z0-9_-]{12,80}$/.test(attemptId)) return json({ ok: false, error: "invalid_attempt_id" }, 400, origin);
      try {
        const result = await env.DB.prepare("DELETE FROM diagnostic_attempts WHERE attempt_id = ?").bind(attemptId).run();
        return json({ ok: true, deleted: Number(result?.meta?.changes || 0) > 0 }, 200, origin);
      } catch (e) {
        return json({ ok: false, error: "delete_failed" }, 500, origin);
      }
    }
    if (request.method === "GET" && url.pathname === "/admin/attempts") {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!safeEqual(token, env.ADMIN_TOKEN)) return json({ ok: false, error: "unauthorized" }, 401, origin);
      if (!env.DB) return json({ ok: false, error: "database_not_configured" }, 503, origin);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const rows = await env.DB.prepare(
        "SELECT attempt_id, student_name, student_class, direction, experience, curriculum_id, curriculum_name, curriculum_detail, curriculum_level, telegram_consent, telegram_status, score, max_score, percentage, completed_at, payload_json FROM diagnostic_attempts ORDER BY completed_at DESC LIMIT ?"
      ).bind(limit).all();
      return json({ ok: true, attempts: rows.results || [] }, 200, origin);
    }
    return json({ ok: false, error: "not_found" }, 404, origin);
  },
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    const configured = Number(env.DATA_RETENTION_DAYS);
    const retentionDays = Number.isFinite(configured) && configured >= 30 && configured <= 365
      ? Math.floor(configured)
      : 180;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare("DELETE FROM diagnostic_attempts WHERE completed_at < ?").bind(cutoff).run();
  }
};
