import {
  randomBytes,
  scrypt as derive,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
import { rows } from "./db.js";
const scrypt = promisify(derive);
export const validPassword = (value) =>
  typeof value === "string" && value.length >= 12 && value.length <= 256;
export const random = () => randomBytes(32).toString("hex");
export const hash = (v) => createHash("sha256").update(v).digest("hex");
export async function passwordHash(value) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + (await scrypt(value, salt, 64)).toString("hex");
}
export async function verify(value, stored) {
  if (!stored) return false;
  const [salt, key] = stored.split(":");
  const result = await scrypt(value, salt, 64);
  const expected = Buffer.from(key, "hex");
  return result.length === expected.length && timingSafeEqual(result, expected);
}
export async function allowedAttempt(identity) {
  const key = hash(identity);
  await rows(
    "INSERT INTO auth_attempts(identity) VALUES(?) ON DUPLICATE KEY UPDATE attempts=IF(window_start < DATE_SUB(NOW(), INTERVAL 15 MINUTE),1,attempts+1),window_start=IF(window_start < DATE_SUB(NOW(), INTERVAL 15 MINUTE),NOW(),window_start)",
    [key],
  );
  return (
    (
      await rows("SELECT attempts FROM auth_attempts WHERE identity=?", [key])
    )[0].attempts < 10
  );
}
export const normalizePhone = (v) =>
  String(v || "")
    .replace(/^\+972/, "0")
    .replace(/\D/g, "");
export function validSubscription(s) {
  try {
    const u = new URL(s.endpoint);
    return (
      u.protocol === "https:" &&
      u.port === "" &&
      !u.username &&
      !u.password &&
      [
        "fcm.googleapis.com",
        "updates.push.services.mozilla.com",
        "web.push.apple.com",
      ].includes(u.hostname) &&
      typeof s.keys?.p256dh === "string" &&
      s.keys.p256dh.length < 200 &&
      typeof s.keys?.auth === "string" &&
      s.keys.auth.length < 100
    );
  } catch {
    return false;
  }
}
export function fail(status, message) {
  return Object.assign(new Error(message), { status });
}
