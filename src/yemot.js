import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";
import { openMedia } from "./media.js";
const base = "https://www.call2all.co.il/ym/api/";
export async function api(command, params = {}) {
  const res = await fetch(base + command, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: config.yemot.token, ...params }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw Error("Yemot HTTP " + res.status);
  const json = await res.json();
  if (json.responseStatus !== "OK")
    throw Error("Yemot command failed: " + command);
  return json;
}
export function validRemote(p) {
  return (
    typeof p === "string" && /^(?:ivr2:)?\/?[0-9/]+(?:v[0-9]+)?\.wav$/.test(p)
  );
}
export async function upload(m) {
  const remote = `ivr2:${config.yemot.folder}/${m.id}v${m.version}.${m.kind === "text" ? "tts" : "wav"}`;
  if (m.kind === "text")
    await api("UploadTextFile", { what: remote, contents: m.body });
  else {
    const form = new FormData();
    form.append("token", config.yemot.token);
    form.append("path", remote);
    form.append("file", await openMedia(m.media), "audio.wav");
    const res = await fetch(base + "UploadFile", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok || (await res.json()).responseStatus !== "OK")
      throw Error("Yemot upload failed");
  }
  const exists = await api("CheckIfFileExists", { path: remote });
  if (
    exists.fileExists !== true &&
    exists.fileExists !== 1 &&
    exists.fileExists !== "1"
  )
    throw Error("Yemot file not confirmed");
  return remote;
}
export async function download(remote, destination) {
  if (!validRemote(remote)) throw Error("Invalid recording path");
  const signal = AbortSignal.timeout(30000);
  const res = await fetch(base + "DownloadFile", {
    method: "POST",
    body: new URLSearchParams({
      token: config.yemot.token,
      path: remote.startsWith("ivr2:") ? remote : "ivr2:" + remote,
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw Error("Recording download failed");
  }
  let total = 0;
  const bounded = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > 12 * 1024 * 1024) callback(Error("Recording too large"));
      else callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(res.body),
    bounded,
    createWriteStream(destination),
    { signal },
  );
}
export async function tzintuk() {
  if (!/^\d+$/.test(config.yemot.list || ""))
    throw Error("Missing free tzintuk list");
  return api("RunTzintuk", { phones: "tzl:" + config.yemot.list });
}
