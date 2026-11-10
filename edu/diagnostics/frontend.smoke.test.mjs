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
