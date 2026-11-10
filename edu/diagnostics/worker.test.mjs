import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./worker.js", import.meta.url), "utf8");
const encoded = Buffer.from(source).toString("base64");
const worker = (await import("data:text/javascript;base64," + encoded)).default;

class FakeStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async run() {
    const s = this.sql;
    const v = this.values;
    if (s.includes("INSERT OR IGNORE INTO diagnostic_attempts")) {
      const id = v[0];
      if (this.db.rows.has(id)) return { meta: { changes: 0 } };
      this.db.rows.set(id, {
        attempt_id: id, student_name: v[1], student_class: v[2], direction: v[3],
        experience: v[4], curriculum_id: v[5], curriculum_name: v[6],
        curriculum_detail: v[7], curriculum_level: v[8], curriculum_year: v[9],
        consent_version: v[10], telegram_consent: v[11], score: v[12],
        max_score: v[13], percentage: v[14], completed_at: v[15],
        payload_json: v[16], telegram_status: v[17], telegram_claimed_at: null
      });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("DELETE FROM diagnostic_attempts WHERE attempt_id")) {
      const changes = this.db.rows.delete(v[0]) ? 1 : 0;
      return { meta: { changes } };
    }
    if (s.startsWith("DELETE FROM diagnostic_attempts WHERE completed_at")) {
      let changes = 0;
      for (const [id, row] of this.db.rows) {
        if (row.completed_at < v[0]) { this.db.rows.delete(id); changes++; }
      }
      return { meta: { changes } };
    }
    if (s.includes("UPDATE diagnostic_attempts") && s.includes("telegram_status = 'sending'")) {
      const row = this.db.rows.get(v[1]);
      if (row && (row.telegram_status === "pending" ||
          (row.telegram_status === "sending" && row.telegram_claimed_at < v[2]))) {
        row.telegram_status = "sending"; row.telegram_claimed_at = v[0];
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    return { meta: { changes: 0 } };
  }
  async first() {
    const id = this.values[0];
    const row = this.db.rows.get(id);
    if (!row) return null;
    if (this.sql.includes("SELECT telegram_status")) return { telegram_status: row.telegram_status };
    return {
      attempt_id: row.attempt_id, payload_json: row.payload_json,
      telegram_status: row.telegram_status, telegram_claimed_at: row.telegram_claimed_at,
      telegram_consent: row.telegram_consent, curriculum_level: row.curriculum_level
    };
  }
  async all() {
    const limit = this.values[0] || 50;
    return { results: [...this.db.rows.values()].sort((a,b)=>b.completed_at.localeCompare(a.completed_at)).slice(0,limit) };
  }
}
class FakeDB {
  constructor() { this.rows = new Map(); }
  prepare(sql) { return new FakeStatement(this, sql); }
}

function validPayload(overrides = {}) {
  return {
    attemptId: "attempt_test_000001",
    studentName: "Тестовый ученик",
    studentClass: "7",
    direction: "Информатика",
    experience: "",
    curriculumId: "by",
    curriculumName: "Беларусь — учебная программа Министерства образования",
    curriculumDetail: "",
    curriculumLevel: "",
    curriculumYear: "2026/2027",
    consent: true,
    consentVersion: "test-v1",
    consentAt: "2026-11-10T10:00:00.000Z",
    telegramConsent: false,
    bankProgramMatched: false,
    score: 8,
    maxScore: 15,
    completedAt: "2026-11-10T10:00:00.000Z",
    weakTopics: ["Алгоритмы — 1/3"],
    answers: Array.from({ length: 15 }, (_, i) => ({
      question: "Вопрос " + (i + 1),
      answerText: "Ответ ученика",
      correctText: "Правильный ответ",
      status: "answered",
      statusLabel: i < 8 ? "Верно" : "Неверно",
      topic: "Алгоритмы",
      difficulty: i < 5 ? "basic" : "medium",
      explanation: "Пояснение"
    })),
    ...overrides
  };
}
async function post(db, payload) {
  const req = new Request("https://worker.test/diagnostics", {
    method: "POST",
    headers: { Origin: "https://katmischenko.github.io", "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const res = await worker.fetch(req, { DB: db });
  return { status: res.status, body: await res.json() };
}

test("saves an opted-in archive record without sending Telegram", async () => {
  const db = new FakeDB();
  const result = await post(db, validPayload());
  assert.equal(result.status, 200);
  assert.equal(result.body.saved, true);
  assert.equal(result.body.telegramNotRequested, true);
  assert.equal(db.rows.size, 1);
  const row = [...db.rows.values()][0];
  assert.equal(row.curriculum_id, "by");
  assert.equal(row.curriculum_year, "2026/2027");
  assert.equal(row.telegram_consent, 0);
});

test("retry with same attemptId does not create a duplicate record", async () => {
  const db = new FakeDB();
  await post(db, validPayload());
  const result = await post(db, validPayload({ studentName: "Изменённое имя" }));
  assert.equal(result.status, 200);
  assert.equal(result.body.duplicate, true);
  assert.equal(db.rows.size, 1);
  assert.equal([...db.rows.values()][0].student_name, "Тестовый ученик");
});

test("rejects Russian grade-six informatics as a federal-program profile", async () => {
  const db = new FakeDB();
  const result = await post(db, validPayload({
    direction: "Информатика", studentClass: "6", curriculumId: "ru",
    curriculumName: "Россия — ФРП", curriculumYear: "2026/2027"
  }));
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "local_informatics_program_required");
  assert.equal(db.rows.size, 0);
});

test("requires a level for Russian senior-school mathematics", async () => {
  const db = new FakeDB();
  const result = await post(db, validPayload({
    direction: "Математика", studentClass: "10", curriculumId: "ru",
    curriculumName: "Россия — ФРП", curriculumYear: "2026/2027",
    curriculumLevel: ""
  }));
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "curriculum_level_required");
});

test("rejects a digital profile without experience selection", async () => {
  const db = new FakeDB();
  const result = await post(db, validPayload({
    direction: "Python", studentClass: "5", curriculumId: "self",
    curriculumName: "Собственная образовательная траектория",
    curriculumYear: "", experience: ""
  }));
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "experience_required");
});

test("admin can list and delete a stored attempt", async () => {
  const db = new FakeDB();
  await post(db, validPayload());
  const get = await worker.fetch(new Request("https://worker.test/admin/attempts?limit=50", {
    headers: { Authorization: "Bearer test-admin-token" }
  }), { DB: db, ADMIN_TOKEN: "test-admin-token" });
  assert.equal(get.status, 200);
  const list = await get.json();
  assert.equal(list.attempts.length, 1);
  assert.equal(list.attempts[0].curriculum_year, "2026/2027");

  const del = await worker.fetch(new Request("https://worker.test/admin/attempts/attempt_test_000001", {
    method: "DELETE", headers: { Authorization: "Bearer test-admin-token" }
  }), { DB: db, ADMIN_TOKEN: "test-admin-token" });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).deleted, true);
  assert.equal(db.rows.size, 0);
});

test("scheduled cleanup deletes only records older than configured retention", async () => {
  const db = new FakeDB();
  db.rows.set("old_attempt_000001", { attempt_id: "old_attempt_000001", completed_at: "2025-01-01T00:00:00.000Z" });
  db.rows.set("new_attempt_000001", { attempt_id: "new_attempt_000001", completed_at: new Date().toISOString() });
  await worker.scheduled({}, { DB: db, DATA_RETENTION_DAYS: "180" }, {});
  assert.equal(db.rows.has("old_attempt_000001"), false);
  assert.equal(db.rows.has("new_attempt_000001"), true);
});
