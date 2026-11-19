import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import express from "express";
import { chromium } from "playwright-core";

const browserPath = process.env.CHROMIUM_PATH ||
  ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
test("refreshes leave unchanged history alone and patch audio and reply previews in place", {
  skip: browserPath || process.env.CI ? false : "Chromium is unavailable",
  timeout: 30000,
}, async (t) => {
  assert.ok(browserPath, "Set CHROMIUM_PATH to the installed Chromium or Chrome binary");
  const app = express();
  app.use(express.static(fileURLToPath(new URL("../../public", import.meta.url))));
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const browser = await chromium.launch({ executablePath: browserPath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  t.after(() => page.close());

  const history = Array.from({ length: 150 }, (_, index) => ({
    id: index + 1,
    user_id: 1,
    kind: "text",
    body: "הודעה " + (index + 1),
    name: "דנה",
    created_at: "2026-11-01T10:00:00Z",
    version: 1,
    synced_version: 1,
  }));
  const parent = history[118];
  const voice = Object.assign(history[119], {
    kind: "audio",
    body: "",
    transcript: null,
    parent_id: parent.id,
    parent_name: parent.name,
    parent_body: parent.body,
    synced_version: 0,
  });
  await page.route("**/api/me", (route) => route.fulfill({
    json: { csrf: "fixture", user: { id: 1, name: "דנה", admin: false, last_read: 0 } },
  }));
  await page.route("**/api/messages**", (route) => {
    const { pathname, searchParams } = new URL(route.request().url());
    if (pathname.endsWith("/versions")) return route.fulfill({ json: [] });
    const before = Number(searchParams.get("before") || Infinity);
    return route.fulfill({
      json: history.filter((m) => m.id < before).reverse().slice(0, 50),
    });
  });
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.locator("#message-101").waitFor();
  await page.locator("#older").evaluate((node) => node.click());
  await page.locator("#message-51").waitFor();
  await page.locator("#older").evaluate((node) => node.click());
  await page.locator("#message-1").waitFor();

  await page.locator("#message-120 summary").click();
  await page.evaluate(() => {
    const scroller = document.querySelector("#conversation");
    scroller.style.scrollBehavior = "auto";
    document.querySelector("#message-118").scrollIntoView({ block: "start" });
    const metrics = { geometryReads: 0, writes: 0 };
    const rect = Element.prototype.getBoundingClientRect;
    const observer = new MutationObserver((records) => { metrics.writes += records.length; });
    observer.observe(scroller, { attributes: true, childList: true, subtree: true });
    observer.observe(document.querySelector("#read"), { childList: true });
    Element.prototype.getBoundingClientRect = function () {
      if (this === scroller || this.matches("#messages > article")) metrics.geometryReads++;
      return rect.call(this);
    };
    window.renderFixture = {
      metrics,
      audio: document.querySelector("#message-120 audio"),
      anchorTop: rect.call(document.querySelector("#message-118")).top,
    };
  });

  async function refresh() {
    const completed = page.waitForResponse((response) =>
      new URL(response.url()).searchParams.get("before") === "51",
    );
    await page.locator("#search").dispatchEvent("input");
    await completed;
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
  }
  await refresh();
  assert.deepEqual(await page.evaluate(() => window.renderFixture.metrics), {
    geometryReads: 0,
    writes: 0,
  });

  parent.body = "הודעה אחרי עריכה";
  parent.version = 2;
  voice.parent_body = parent.body;
  await refresh();
  assert.match(await page.locator("#message-120 .quote").innerText(), /הודעה אחרי עריכה/);

  voice.transcript = "תמלול חדש";
  voice.version = 2;
  voice.synced_version = 2;
  await refresh();
  assert.equal(await page.locator("#message-120 details p").innerText(), "תמלול חדש");
  assert.equal(await page.locator("#message-120 .sync").innerText(), "✓ זמין גם בקו");
  assert.equal(await page.locator("#message-120 details").evaluate((node) => node.open), true);
  assert.equal(await page.locator("#message-120 audio").evaluate((node) => node === window.renderFixture.audio), true);
  assert.ok(await page.locator("#message-118").evaluate((node) =>
    Math.abs(node.getBoundingClientRect().top - window.renderFixture.anchorTop) <= 1,
  ));
  await page.locator("#message-120 .actions button").last().click();
  assert.equal(await page.locator("#editBody").inputValue(), "תמלול חדש");
});
