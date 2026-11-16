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
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
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
  await page.locator("#body").fill("<img src=x onerror=alert(1)>");
  await page.getByRole("button", { name: "שליחה", exact: false }).click();
  await page
    .getByText("<img src=x onerror=alert(1)>", { exact: true })
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
  await page.locator("#logout").click();
  await page.locator("#login").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: login, messages, reply, edit, audio, transcript, XSS, search, mobile width, read, logout",
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await db.end();
}
