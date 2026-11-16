import { chromium } from "playwright-core";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
if (!process.env.TEST_DB_NAME?.endsWith("_test"))
  throw Error("Set TEST_DB_NAME ending in _test");
process.env.DB_NAME = process.env.TEST_DB_NAME;
process.env.DB_PORT = process.env.TEST_DB_PORT || "3307";
process.env.YEMOT_ENABLED = "false";
const { db, rows, migrate } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { passwordHash } = await import("../src/security.js");
const { createApp } = await import("../src/app.js");
await migrate();
const username = "browser_" + Date.now(),
  password = randomBytes(24).toString("hex");
await rows(
  "INSERT INTO users(username,name,password_hash,admin) VALUES(?,?,?,1)",
  [username, "מנהל הקבוצה", await passwordHash(password)],
);
const server = (await createApp()).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
config.origin = "http://127.0.0.1:" + server.address().port;
let browser;
const errors = [];
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.clock.install();
  await page.addInitScript(() => {
    window.testHttp = {};
    const nativeFetch = window.fetch;
    window.fetch = async (url, options) => {
      if (window.testHttp.path && url === window.testHttp.path) {
        window.testHttp.path = null;
        // Emulate a response that arrives even after cancellation.
        const response = await nativeFetch(url, { ...options, signal: undefined });
        const body = await response.text();
        await new Promise(resolve => { window.testHttp.release = resolve; });
        return new Response(body, { status: response.status, headers: response.headers });
      }
      return nativeFetch(url, options);
    };
    window.testMedia = { streams: [] };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await getUserMedia(...args);
      window.testMedia.streams.push(stream);
      if (window.testMedia.holdPermission)
        await new Promise(resolve => { window.testMedia.releasePermission = resolve; });
      return stream;
    };
    const NativeRecorder = window.MediaRecorder;
    window.MediaRecorder = class extends NativeRecorder {
      constructor(...args) {
        super(...args);
        window.testMedia.recorder = this;
      }
    };
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(config.origin);
  await mkdir("docs/screenshots", { recursive: true });
  await page.screenshot({ path: "docs/screenshots/login.png", fullPage: true });
  await page.locator("[name=username]").fill(username);
  await page.locator("[name=password]").fill(password);
  await page.getByRole("button", { name: "נכנסים לשיחה" }).click();
  await page.locator("#chat").waitFor({ state: "visible" });
  const unique = "שלום לכולם, שמח להצטרף לשיחה " + Date.now();
  await page.locator("#body").fill(unique);
  await page.getByRole("button", { name: "שליחה", exact: false }).click();
  const card = page
    .locator("article")
    .filter({
      has: page.locator(".content").getByText(unique, { exact: true }),
    });
  await card.waitFor();
  const oldMessageId = Number((await card.getAttribute("id")).replace("message-", ""));
  await card.getByRole("button", { name: "תגובה", exact: true }).click();
  await page.locator("#body").fill("תגובה מתוך הדפדפן " + unique);
  await page.getByRole("button", { name: "שליחה", exact: false }).click();
  await page
    .getByText("תגובה מתוך הדפדפן " + unique, { exact: true })
    .waitFor();
  await page.locator("#reply").waitFor({ state: "hidden" });
  await card.getByRole("button", { name: "עריכה", exact: true }).click();
  await page.locator("#editBody").fill(unique + " — נערך");
  await page.getByRole("button", { name: "שמירה", exact: true }).click();
  await page.getByText(unique + " — נערך", { exact: true }).waitFor();
  const b = Buffer.alloc(16044);
  b.write("RIFF");
  b.writeUInt32LE(16036, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(16000, 40);
  await page
    .locator("#audio")
    .setInputFiles({ name: "recording.wav", mimeType: "audio/wav", buffer: b });
  const audioCreated = page.waitForResponse(
    (r) => r.url().endsWith("/api/audio") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "שליחה", exact: false }).click();
  const audioResult = await (await audioCreated).json();
  const audio = page.locator("#message-" + audioResult.id);
  await audio.waitFor();
  await audio.locator("audio").evaluate(n => n.dataset.originalPlayer = "yes");
  await audio.getByRole("button", { name: "עריכת תמלול" }).click();
  await page.locator("#editBody").fill("הקלטה מהמפגש שלנו. נתראה בשבוע הבא.");
  await page.getByRole("button", { name: "שמירה", exact: true }).click();
  await audio
    .getByText("הקלטה מהמפגש שלנו. נתראה בשבוע הבא.")
    .waitFor({ state: "attached" });
  if (!(await audio.locator("details").evaluate((n) => n.open)))
    await audio.locator("summary").click();
  await audio.getByText("הקלטה מהמפגש שלנו. נתראה בשבוע הבא.").waitFor();
  assert.equal(await audio.locator("audio").getAttribute("data-original-player"), "yes");
  // Exercise history outside the latest page, then an edit from another client.
  const { createMessage } = await import("../src/messages.js");
  const me = await (await page.request.get(config.origin + "/api/me")).json();
  for (let i = 0; i < 55; i++)
    await createMessage(me.user, { body: "הודעת היסטוריה " + i });
  await page.reload();
  await page.locator("#chat").waitFor({ state: "visible" });
  await page.locator("#messages article").first().waitFor();
  const oldCard = page.locator("#message-" + oldMessageId);
  while (!(await oldCard.count())) await page.locator("#older").click();
  await oldCard.scrollIntoViewIfNeeded();
  const scrollPosition = await oldCard.evaluate(n => n.getBoundingClientRect().top);
  const edited = await page.request.patch(config.origin + "/api/messages/" + oldMessageId, {
    headers: { Origin: config.origin, "X-CSRF-Token": me.csrf },
    data: { version: 2, body: unique + " — עדכון מרחוק" },
  });
  assert.equal(edited.status(), 200);
  await page.clock.fastForward(10000);
  await oldCard.getByText(unique + " — עדכון מרחוק", { exact: true }).waitFor({ timeout: 3000 });
  assert.equal(await oldCard.getAttribute("data-version"), "3");
  assert.ok(Math.abs(await oldCard.evaluate(n => n.getBoundingClientRect().top) - scrollPosition) <= 1, "refresh must preserve the scroll anchor");
  await oldCard.getByRole("button", { name: "עריכה", exact: true }).click();
  await page.locator("#editBody").fill(unique + " — עריכה חוזרת");
  const savedOld = page.waitForResponse(r => r.request().method() === "PATCH");
  await page.getByRole("button", { name: "שמירה", exact: true }).click();
  assert.equal((await savedOld).status(), 200);
  await oldCard.getByText(unique + " — עריכה חוזרת", { exact: true }).waitFor();
  await page.locator("#body").fill("<img src=x onerror=alert(1)>");
  await page.getByRole("button", { name: "שליחה", exact: false }).click();
  await page
    .getByText("<img src=x onerror=alert(1)>", { exact: true })
    .last()
    .waitFor();
  assert.equal(await page.locator("#messages img").count(), 0);
  await page.locator("#search").fill(unique);
  await page.waitForResponse(
    (r) => r.url().includes("/api/messages?search=") && r.status() === 200,
  );
  await page.waitForFunction(() => document.querySelectorAll("#messages article").length === 2);
  assert.equal(await page.locator("#messages article").count(), 2);
  await page.locator("#search").fill("");
  await page.waitForResponse(
    (r) => r.url().endsWith("/api/messages?") && r.status() === 200,
  );
  await page.waitForFunction(() => document.querySelectorAll("#messages article").length > 2);
  await page.locator("#search").blur();
  await page.locator("#toast").waitFor({state:"hidden"});
  await page.locator("#conversation").evaluate(n => { n.style.scrollBehavior="auto"; n.scrollTop=n.scrollHeight; });
  await page.screenshot({
    path: "docs/screenshots/desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "docs/screenshots/mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.locator("#read").click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const secondUsername = username + "_second";
  await rows("INSERT INTO users(username,name,password_hash) VALUES(?,?,?)", [
    secondUsername, "משתמש שני", await passwordHash(password),
  ]);
  async function loginAs(name) {
    await page.locator("[name=username]").fill(name);
    await page.locator("[name=password]").fill(password);
    await page.getByRole("button", { name: "נכנסים לשיחה" }).click();
    await page.locator("#chat").waitFor({ state: "visible" });
    await page.locator("#messages article").first().waitFor();
  }
  async function assertCleanSession() {
    assert.equal(await page.locator("#body").inputValue(), "");
    assert.equal(await page.locator("#audio").inputValue(), "");
    assert.equal(await page.locator("#fileLabel").textContent(), "");
    assert.equal(await page.locator("#reply").isHidden(), true);
    assert.equal(await page.locator("#editDialog").evaluate(n => n.open), false);
    assert.equal(await page.locator("#editBody").inputValue(), "");
    assert.equal(await page.locator("#adminPanel").isHidden(), true);
    assert.equal(await page.locator("#adminPanel").textContent(), "");
    assert.equal(await page.locator("#record").isEnabled(), true);
    assert.equal(await page.locator("#record").textContent(), "◉ הקלטה");
  }
  await page.locator("#admin").click();
  await page.locator("#adminPanel").waitFor({ state: "visible" });
  await page.evaluate(() => { window.testHttp.path = "/api/admin"; });
  await page.locator("#admin").click();
  await page.waitForFunction(() => !!window.testHttp.release);
  await page.locator("#messages article").last().getByRole("button", { name: "תגובה", exact: true }).click();
  await page.locator("#body").fill("טיוטה פרטית של משתמש א");
  await page.locator("#audio").setInputFiles({ name: "private.wav", mimeType: "audio/wav", buffer: b });
  await page.locator("#record").click();
  await page.waitForFunction(() => window.testMedia.recorder?.state === "recording");
  await page.evaluate(() => {
    window.testMedia.previousRecorder = window.testMedia.recorder;
  });
  await page.locator("#messages article").last().getByRole("button", { name: "עריכה", exact: true }).click();
  await page.locator("#editDialog").waitFor({ state: "visible" });
  // Logout is available outside the modal through the same public button handler.
  await page.locator("#logout").evaluate(n => n.click());
  await page.locator("#login").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => window.testMedia.streams.every(s => s.getTracks().every(t => t.readyState === "ended"))), true, "logout must stop microphone tracks");
  await loginAs(secondUsername);
  await page.evaluate(async () => {
    window.testMedia.previousRecorder.dispatchEvent(new BlobEvent("dataavailable", { data: new Blob(["private recording"]) }));
    window.testMedia.previousRecorder.dispatchEvent(new Event("stop"));
    window.testHttp.release();
    await new Promise(requestAnimationFrame);
  });
  await page.waitForFunction(() => document.querySelector("#adminPanel").hidden);
  await assertCleanSession();
  // Expire the session through HTTP while recording, then let polling detect it.
  await page.locator("#body").fill("טיוטה של משתמש ב");
  await page.locator("#record").click();
  await page.waitForFunction(() => window.testMedia.recorder?.state === "recording");
  await page.evaluate(() => {
    window.testMedia.previousRecorder = window.testMedia.recorder;
  });
  const secondMe = await (await page.request.get(config.origin + "/api/me")).json();
  assert.equal((await page.request.post(config.origin + "/api/logout", {
    headers: { Origin: config.origin, "X-CSRF-Token": secondMe.csrf },
  })).status(), 200);
  await page.clock.fastForward(10000);
  await page.locator("#login").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => window.testMedia.streams.every(s => s.getTracks().every(t => t.readyState === "ended"))), true, "session expiry must stop microphone tracks");
  await loginAs(username);
  await page.evaluate(() => {
    window.testMedia.previousRecorder.dispatchEvent(new BlobEvent("dataavailable", { data: new Blob(["expired recording"]) }));
    window.testMedia.previousRecorder.dispatchEvent(new Event("stop"));
  });
  await assertCleanSession();
  // Permission can be granted after logout; the returned stream must be discarded.
  await page.evaluate(() => { window.testMedia.holdPermission = true; });
  await page.locator("#record").click();
  await page.waitForFunction(() => !!window.testMedia.releasePermission);
  await page.locator("#logout").click();
  await page.locator("#login").waitFor({ state: "visible" });
  await loginAs(secondUsername);
  await page.evaluate(() => window.testMedia.releasePermission());
  await page.waitForFunction(() => window.testMedia.streams.every(s => s.getTracks().every(t => t.readyState === "ended")));
  await assertCleanSession();
  await page.locator("#logout").click();
  await page.locator("#login").waitFor({ state: "visible" });
  // A session can expire between login and the first conversation request.
  await page.route("**/api/messages?*", route => route.fulfill({
    status: 401, contentType: "application/json", body: JSON.stringify({ error: "Session expired" }),
  }), { times: 1 });
  await page.locator("[name=username]").fill(username);
  await page.locator("[name=password]").fill(password);
  const expiredRefresh = page.waitForResponse(r => r.url().includes("/api/messages?") && r.status() === 401);
  await page.getByRole("button", { name: "נכנסים לשיחה" }).click();
  await expiredRefresh;
  await page.locator("#login").waitFor({ state: "visible" });
  assert.equal(await page.getByRole("button", { name: "נכנסים לשיחה" }).isEnabled(), true, "expiry during login must allow another login");
  await loginAs(secondUsername);
  await page.locator("#logout").click();
  await page.locator("#login").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: login, messages, reply, edit, audio, transcript, history refresh and re-edit, scroll anchor, XSS, search, mobile width, read, logout, account switch, session expiry, microphone cleanup, late recording/permission/HTTP results",
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await db.end();
}
