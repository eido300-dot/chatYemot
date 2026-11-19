import assert from "node:assert/strict";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { download } from "../src/yemot.js";

const limit = 12 * 1024 * 1024;
const chunk = new Uint8Array(64 * 1024).fill(42);

async function destination(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "chatyemot-download-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "recording.wav");
}

test("Yemot downloads a chunked recording up to the size limit into the destination", async (t) => {
  const file = await destination(t);
  let remaining = limit;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(url, /\/DownloadFile$/);
    assert.equal(options.body.get("path"), "ivr2:/9/1.wav");
    return new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(chunk);
          remaining -= chunk.length;
          if (remaining === 0) controller.close();
        },
      }),
    );
  });

  await download("/9/1.wav", file);
  assert.equal((await stat(file)).size, limit);
  const handle = await open(file);
  try {
    const lastByte = Buffer.alloc(1);
    await handle.read(lastByte, 0, lastByte.length, limit - 1);
    assert.equal(lastByte[0], 42);
  } finally {
    await handle.close();
  }
});

test("Yemot cancels the response when a recording exceeds the size limit", async (t) => {
  const file = await destination(t);
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );

  await assert.rejects(download("ivr2:/9/1.wav", file), /Recording too large/);
  assert.equal(cancelled, true);
  assert.ok((await stat(file)).size <= limit);
});

test("Yemot cancels an unfinished recording when the download times out", async (t) => {
  const file = await destination(t);
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    assert.equal(milliseconds, 30000);
    return timeout.signal;
  });
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.signal, timeout.signal);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
        },
        pull() {
          timeout.abort();
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  });

  await assert.rejects(download("/9/1.wav", file), { name: "AbortError" });
  assert.equal(cancelled, true);
});
