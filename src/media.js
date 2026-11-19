import { spawn } from "node:child_process";
import { openAsBlob } from "node:fs";
import { mkdir, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { random } from "./security.js";
import { config } from "./config.js";
export async function prepareMedia() {
  await mkdir(path.join(config.data, "media"), { recursive: true });
  await mkdir(path.join(config.data, "tmp"), { recursive: true });
}
export function mediaPath(name) {
  if (!/^[a-f0-9]{64}\.wav$/.test(name)) throw Error("Invalid media name");
  return path.join(config.data, "media", name);
}
export function openMedia(name) {
  return openAsBlob(mediaPath(name), { type: "audio/wav" });
}
export async function convert(input) {
  const name = random() + ".wav",
    output = mediaPath(name);
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(
        "ffmpeg",
        [
          "-nostdin",
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          input,
          "-t",
          "180",
          "-ac",
          "1",
          "-ar",
          "8000",
          "-c:a",
          "pcm_s16le",
          "-y",
          output,
        ],
        { stdio: "ignore" },
      );
      const timer = setTimeout(() => {
        p.kill("SIGKILL");
        reject(Error("Audio conversion timed out"));
      }, 45000);
      p.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      p.on("exit", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(Error("Invalid audio"));
      });
    });
    if ((await stat(output)).size < 100) throw Error("Empty audio");
    return name;
  } catch (e) {
    await unlink(output).catch(() => {});
    throw e;
  }
}
