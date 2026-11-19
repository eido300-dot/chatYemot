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
export async function download(remote) {
  if (!validRemote(remote)) throw Error("Invalid recording path");
  const res = await fetch(base + "DownloadFile", {
    method: "POST",
    body: new URLSearchParams({
      token: config.yemot.token,
      path: remote.startsWith("ivr2:") ? remote : "ivr2:" + remote,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw Error("Recording download failed");
  const reader = res.body.getReader();
  let total = 0;
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > 12 * 1024 * 1024) {
      await reader.cancel();
      throw Error("Recording too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
export async function tzintuk() {
  if (!/^\d+$/.test(config.yemot.list || ""))
    throw Error("Missing free tzintuk list");
  return api("RunTzintuk", { phones: "tzl:" + config.yemot.list });
}
