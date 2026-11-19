import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Yemot receives the WAV as multipart data and confirms the remote file", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "chatyemot-upload-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  process.env.DATA_DIR = dataDir;
  process.env.YEMOT_TOKEN = "test-token";
  process.env.YEMOT_MEDIA_FOLDER = "/9";
  const { mediaPath, prepareMedia } = await import("../src/media.js");
  const { upload } = await import("../src/yemot.js");
  const media = "a".repeat(64) + ".wav";
  const wav = Buffer.from("524946460102030457415645", "hex");
  await prepareMedia();
  await writeFile(mediaPath(media), wav);

  const commands = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const command = new URL(url).pathname.split("/").at(-1);
    commands.push(command);
    const req = new Request(url, options);
    if (command === "UploadFile") {
      assert.match(req.headers.get("content-type"), /^multipart\/form-data;/);
      const form = await req.formData();
      const file = form.get("file");
      assert.equal(form.get("token"), "test-token");
      assert.equal(form.get("path"), "ivr2:/9/4v2.wav");
      assert.equal(file.name, "audio.wav");
      assert.equal(file.type, "audio/wav");
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), wav);
    } else {
      const params = new URLSearchParams(await req.text());
      assert.equal(params.get("path"), "ivr2:/9/4v2.wav");
    }
    return Response.json({ responseStatus: "OK", fileExists: true });
  });

  assert.equal(await upload({ id: 4, version: 2, kind: "audio", media }), "ivr2:/9/4v2.wav");
  assert.deepEqual(commands, ["UploadFile", "CheckIfFileExists"]);
});
