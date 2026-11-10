import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
let server, browser, baseUrl;

before(async () => {
  server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      const file = resolve(root, "." + pathname);
      if (file !== root && !file.startsWith(root + sep)) {
        res.writeHead(403).end("Forbidden"); return;
      }
      const data = await readFile(file);
      const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };
      res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  baseUrl = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolveClose => server.close(resolveClose));
});

test("desktop: curriculum selection, unknown answer, back navigation and local-only result", async () => {
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const pageErrors = [];
  const postRequests = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", request => {
    if (request.method() === "POST") postRequests.push(request.url());
  });

  await page.goto(baseUrl + "/edu/diagnostika.html", { waitUntil: "domcontentloaded" });
  assert.match(await page.title(), /Диагностика/);
  await page.locator("#student").fill("Тестовый ученик");
  await page.locator("#direction").selectOption("informatics");
  await page.locator("#grade").selectOption("6");
  const programOptions = await page.locator("#curriculum option").evaluateAll(nodes => nodes.map(n => n.value));
  assert.ok(!programOptions.includes("ru"), "Russian grade-six informatics must use a local school program");
  await page.locator("#curriculum").selectOption("other");
  await page.locator("#curriculum-detail").fill("Тестовая школьная программа");
  assert.equal(await page.locator("#start").isEnabled(), true);

  await page.locator("#start").click();
  await page.waitForFunction(() => document.querySelector("#counter")?.textContent.trim() === "вопрос 1 из 15");
  assert.equal((await page.locator("#counter").textContent()).trim(), "вопрос 1 из 15");
  await page.locator("#unknown").click();
  assert.equal((await page.locator("#counter").textContent()).trim(), "вопрос 1 из 15");
  await page.locator("#next").click();
  assert.equal((await page.locator("#counter").textContent()).trim(), "вопрос 2 из 15");
  await page.locator("#back").click();
  assert.equal((await page.locator("#counter").textContent()).trim(), "вопрос 1 из 15");
  assert.equal(await page.locator("#unknown").getAttribute("aria-pressed"), "true");
  await page.locator("#skip").click();
  assert.equal((await page.locator("#counter").textContent()).trim(), "вопрос 2 из 15");

  for (let i = 0; i < 13; i++) await page.locator("#skip").click();
  assert.equal((await page.locator("#counter").textContent()).trim(), "вопрос 15 из 15");
  await page.locator("#skip").click();
  await page.locator("#save-status").waitFor();
  assert.equal(await page.locator("#result").isVisible(), true);
  assert.match(await page.locator("#save-status").textContent(), /временно отключены/);
  assert.equal(postRequests.length, 0, "remote saving is disabled; no POST request should be sent");
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test("program year and senior level are required for grades 10–11", async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl + "/edu/diagnostika.html", { waitUntil: "domcontentloaded" });
  await page.locator("#student").fill("Тест");
  await page.locator("#direction").selectOption("physics");
  await page.locator("#grade").selectOption("10");
  await page.locator("#curriculum").selectOption("ru");
  assert.equal(await page.locator("#curriculum-year-wrap").isVisible(), true);
  assert.equal(await page.locator("#curriculum-level-wrap").isVisible(), true);
  assert.equal(await page.locator("#start").isEnabled(), false);
  await page.locator("#curriculum-level").selectOption("basic");
  assert.equal(await page.locator("#start").isEnabled(), true);
  await page.close();
});

test("Belarus grade-eight physics pilot asks for the study level", async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl + "/edu/diagnostika.html", { waitUntil: "domcontentloaded" });
  await page.locator("#student").fill("Тест");
  await page.locator("#direction").selectOption("physics");
  await page.locator("#grade").selectOption("8");
  await page.locator("#curriculum").selectOption("by");
  assert.equal(await page.locator("#curriculum-year-wrap").isVisible(), true);
  assert.equal(await page.locator("#curriculum-level-wrap").isVisible(), true);
  assert.equal(await page.locator("#start").isEnabled(), false);
  await page.locator("#curriculum-level").selectOption("advanced");
  assert.equal(await page.locator("#start").isEnabled(), true);
  await page.close();
});

test("Belarus grade-nine informatics allows an explicit advanced track", async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl + "/edu/diagnostika.html", { waitUntil: "domcontentloaded" });
  await page.locator("#student").fill("Тест");
  await page.locator("#direction").selectOption("informatics");
  await page.locator("#grade").selectOption("9");
  await page.locator("#curriculum").selectOption("by");
  assert.equal(await page.locator("#curriculum-level-wrap").isVisible(), true);
  assert.match(await page.locator("#curriculum-level-hint").textContent(), /дополнительными учебными часами/);
  assert.equal(await page.locator("#start").isEnabled(), false);
  await page.locator("#curriculum-level").selectOption("advanced");
  assert.equal(await page.locator("#start").isEnabled(), true);
  await page.close();
});

test("Belarus advanced informatics profile requests the matching level-specific bank", async () => {
  const page = await browser.newPage();
  const requested = [];
  const mockBank = {
    bankId: "informatics-9-by-2026-2027-advanced",
    reviewStatus: "teacher_review_draft",
    questions: Array.from({ length: 15 }, (_, i) => ({
      id: "mock-" + (i + 1),
      topic: "Проверка",
      skill: "Проверка",
      difficulty: i < 5 ? "basic" : i < 12 ? "medium" : "advanced",
      type: "choice",
      question: "Тестовый вопрос " + (i + 1),
      options: ["Вариант A", "Вариант B"],
      correctIndex: 0,
      correctText: "Вариант A",
      explanation: "Тестовое объяснение."
    }))
  };
  page.on("request", request => {
    if (request.url().includes("question-bank-informatics-9-by-2026-2027-advanced.json")) requested.push(request.url());
  });
  await page.route("**/question-bank-informatics-9-by-2026-2027-advanced.json", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(mockBank)
  }));
  await page.goto(baseUrl + "/edu/diagnostika.html", { waitUntil: "domcontentloaded" });
  await page.locator("#student").fill("Тест");
  await page.locator("#direction").selectOption("informatics");
  await page.locator("#grade").selectOption("9");
  await page.locator("#curriculum").selectOption("by");
  await page.locator("#curriculum-level").selectOption("advanced");
  await page.locator("#start").click();
  await page.waitForFunction(() => document.querySelector("#question")?.textContent.includes("Тестовый вопрос 1"));
  assert.equal(requested.length, 1);
  assert.match(await page.locator("#profile-note").textContent(), /отдельный черновик/);
  await page.close();
});

test("digital direction requires an explicit experience level", async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl + "/edu/diagnostika.html", { waitUntil: "domcontentloaded" });
  await page.locator("#student").fill("Тест");
  await page.locator("#direction").selectOption("python");
  await page.locator("#grade").selectOption("5");
  await page.locator("#curriculum").selectOption("self");
  assert.equal(await page.locator("#experience-wrap").isVisible(), true);
  assert.equal(await page.locator("#start").isEnabled(), false);
  await page.locator("#experience").selectOption("beginner");
  assert.equal(await page.locator("#start").isEnabled(), true);
  await page.close();
});

test("teacher archive: renders attempts, filters and compares two runs", async () => {
  const page = await browser.newPage();
  const makeAttempt = (id, score, percentage, date) => ({
    attempt_id: id,
    student_name: "Тестовый ученик",
    student_class: "7",
    direction: "Математика",
    curriculum_id: "ru",
    curriculum_name: "Россия — ФРП",
    curriculum_year: "2026/2027",
    curriculum_level: "basic",
    curriculum_detail: "",
    experience: null,
    score,
    percentage,
    completed_at: date,
    telegram_consent: false,
    telegram_status: "not_requested",
    payload_json: JSON.stringify({
      studentName: "Тестовый ученик",
      studentClass: "7",
      direction: "Математика",
      score,
      percentage,
      bankProgramMatched: true,
      bankId: "math-7-ru-2026-2027",
      bankReviewStatus: "teacher_review_draft",
      answers: [{
        question: "Сократи дробь 6/8.",
        answerText: score > 8 ? "3/4" : "6/8",
        correctText: "3/4",
        statusLabel: score > 8 ? "Верно" : "Неверно",
        topic: "Дроби",
        difficulty: "basic",
        explanation: "Числитель и знаменатель делим на 2."
      }]
    })
  });
  await page.route("**/admin/attempts?limit=100", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      attempts: [
        makeAttempt("attempt-1", 8, 53, "2026-11-09T10:00:00.000Z"),
        makeAttempt("attempt-2", 10, 67, "2026-11-10T10:00:00.000Z")
      ]
    })
  }));
  await page.goto(baseUrl + "/edu/diagnostics/archive.html", { waitUntil: "domcontentloaded" });
  await page.locator("#token").fill("test-admin-token");
  await page.locator("#load").click();
  await page.waitForFunction(() => !document.querySelector("#archive").hidden);
  assert.equal(await page.locator("#list .attempt").count(), 2);
  assert.match(await page.locator("#list").textContent(), /отдельный черновик программы/);
  await page.locator("#search").fill("нет такого ученика");
  assert.equal(await page.locator("#list .attempt").count(), 0);
  await page.locator("#search").fill("");
  await page.locator('[data-compare="attempt-1"]').check();
  await page.locator('[data-compare="attempt-2"]').check();
  assert.equal(await page.locator("#compare").isEnabled(), true);
  await page.locator("#compare").click();
  assert.equal(await page.locator("#compare-view").isVisible(), true);
  assert.match(await page.locator("#compare-view").textContent(), /Сравнение попыток/);
  assert.match(await page.locator("#compare-view").textContent(), /Дроби/);
  await page.evaluate(() => {
    window.__printedHtml = "";
    window.open = () => ({
      document: {
        write: html => { window.__printedHtml = html; },
        close: () => {}
      }
    });
  });
  await page.locator('[data-print="0"]').click();
  assert.match(await page.evaluate(() => window.__printedHtml), /Диагностика Mischenko Edu/);
  assert.match(await page.evaluate(() => window.__printedHtml), /Сократи дробь 6\/8/);
  await page.close();
});

test("mobile: setup fits a narrow viewport without horizontal overflow", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(baseUrl + "/edu/diagnostika.html", { waitUntil: "domcontentloaded" });
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth
  }));
  assert.ok(dimensions.content <= dimensions.viewport, JSON.stringify(dimensions));
  assert.equal(await page.locator("#start").isVisible(), true);
  await page.close();
});
