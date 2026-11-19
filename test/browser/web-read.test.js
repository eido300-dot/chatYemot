import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright-core";

const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/conversation-view.js", ["conversation-view.js", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]],
]);

test("read acknowledgements update the marker without reloading history or moving backward", { timeout: 10_000 }, async (t) => {
  const executablePath = process.env.CHROMIUM_PATH ||
    ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
  assert.ok(executablePath, "Set CHROMIUM_PATH to the installed Chromium or Chrome binary");
  const browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ serviceWorkers: "block" });
  page.setDefaultTimeout(2000);
  await page.clock.install();
  let latest = 1;
  let historyRequests = 0;
  const firstRead = Promise.withResolvers();
  const releaseFirstRead = Promise.withResolvers();
  t.after(() => releaseFirstRead.resolve());
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (files.has(path)) {
      const [file, contentType] = files.get(path);
      return route.fulfill({
        contentType,
        body: await readFile(new URL("../../public/" + file, import.meta.url)),
      });
    }
    if (path === "/api/me") {
      return route.fulfill({
        json: { csrf: "test", user: { id: 1, name: "Writer", last_read: 0 } },
      });
    }
    if (path === "/api/messages") {
      historyRequests++;
      return route.fulfill({
        json: Array.from({ length: latest }, (_, n) => ({
          id: latest - n, kind: "text", body: "message " + (latest - n),
          user_id: 1, name: "Writer", version: 1, synced_version: 1,
          created_at: "2026-11-01T10:00:00.000Z",
        })),
      });
    }
    if (path === "/api/read") {
      const { id } = route.request().postDataJSON();
      if (id === 1) {
        firstRead.resolve();
        await releaseFirstRead.promise;
      }
      return route.fulfill({ json: { ok: true, last_read: id } });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto("http://chatyemot.test/");
  await page.getByText("message 1").waitFor();
  await page.locator("#read").click();
  await firstRead.promise;

  latest = 2;
  await page.clock.runFor(10_000);
  await page.getByText("message 2").waitFor();
  await page.locator("#read").click();
  await page.getByRole("button", { name: "הכול נקרא ✓" }).waitFor();
  assert.equal(historyRequests, 2, "initial read and regular poll only");

  const staleResponse = page.waitForResponse((r) =>
    r.url().endsWith("/api/read") && r.request().postDataJSON().id === 1,
  );
  releaseFirstRead.resolve();
  await (await staleResponse).finished();
  await page.clock.runFor(100);
  assert.equal(await page.locator("#read").textContent(), "הכול נקרא ✓");
  assert.equal(historyRequests, 2);
});
