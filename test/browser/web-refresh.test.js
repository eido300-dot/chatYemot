import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";

let browser;
before(async () => {
  const executablePath = process.env.CHROMIUM_PATH ||
    ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
  assert.ok(executablePath, "Set CHROMIUM_PATH to the installed Chromium or Chrome binary");
  browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox"],
  });
});
after(() => browser?.close());

const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/conversation-view.js", ["conversation-view.js", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]],
]);

function message(id, body) {
  return {
    id, body, kind: "text", user_id: 1, name: "Writer", version: 1,
    synced_version: 1, created_at: "2026-11-01T10:00:00.000Z",
  };
}

async function openConversation(t, messages) {
  const page = await browser.newPage({ serviceWorkers: "block" });
  t.after(() => page.close());
  page.setDefaultTimeout(2000);
  await page.clock.install();
  const requests = [];
  let nextHold;
  await page.route("**/*", async (route) => {
    const { pathname, searchParams } = new URL(route.request().url());
    if (files.has(pathname)) {
      const [file, contentType] = files.get(pathname);
      const body = await readFile(new URL("../../public/" + file, import.meta.url));
      return route.fulfill({ contentType, body });
    }
    if (pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: 1, name: "Writer", last_read: 0 }, csrf: "test" },
      });
    }
    if (pathname !== "/api/messages") return route.fulfill({ status: 404 });
    if (route.request().method() === "POST") {
      const id = messages[0].id + 1;
      messages.unshift(message(id, route.request().postDataJSON().body));
      return route.fulfill({ status: 201, json: { id } });
    }
    const search = searchParams.get("search") || "";
    const before = searchParams.get("before");
    const result = messages.filter((m) =>
      m.body.includes(search) && (!before || m.id < Number(before)),
    ).slice(0, 50);
    requests.push({ search, before });
    if (nextHold) {
      const hold = nextHold;
      nextHold = null;
      hold.started.resolve();
      await hold.release.promise;
    }
    return route.fulfill({ json: result });
  });
  await page.goto("http://chatyemot.test/");
  await page.locator("#messages article").first().waitFor();
  async function holdPoll() {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    nextHold = { started, release };
    await page.clock.runFor(10_000);
    await started.promise;
    return release.resolve;
  }
  return { page, requests, holdPoll };
}

test("latest search survives a pending poll without reusing an older cursor", { timeout: 10_000 }, async (t) => {
  const messages = Array.from({ length: 50 }, (_, n) => message(100 - n, "row " + n));
  messages[20] = message(80, "latest needle");
  const { page, requests, holdPoll } = await openConversation(t, messages);
  const release = await holdPoll();
  await page.locator("#search").fill("obsolete");
  await page.clock.runFor(350);
  await page.locator("#search").fill("needle");
  await page.locator("#older").click();
  await page.clock.runFor(350);
  release();
  await page.getByText("latest needle").waitFor();
  await page.waitForFunction(() => document.querySelectorAll("#messages article").length === 1);
  assert.deepEqual(requests, [
    { search: "", before: null },
    { search: "", before: null },
    { search: "needle", before: null },
  ]);
});

test("sending a message queues a fresh read behind a pending poll", { timeout: 10_000 }, async (t) => {
  const { page, requests, holdPoll } = await openConversation(t, [message(1, "original")]);
  const release = await holdPoll();
  await page.locator("#body").fill("sent during poll");
  await page.locator("#composer button[type=submit]").click();
  await page.waitForFunction(() => document.querySelector("#body").value === "");
  release();
  await page.getByText("sent during poll").waitFor();
  assert.equal(requests.length, 3);
});
