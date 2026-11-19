import webpush from "web-push";
import { writeFile, unlink, readFile } from "node:fs/promises";
import path from "node:path";
import { db, rows, transaction } from "./db.js";
import { enqueue, enqueueMany } from "./messages.js";
import { config } from "./config.js";
import { random, validSubscription } from "./security.js";
import { convert, mediaPath } from "./media.js";
import * as yemot from "./yemot.js";
export function createWorker(adapters = {}) {
  const remote = { ...yemot, ...adapters };
  let timer,
    stopping = false,
    current;
  const pushReady = !!(config.push.publicKey && config.push.privateKey);
  if (pushReady)
    webpush.setVapidDetails(
      config.push.subject,
      config.push.publicKey,
      config.push.privateKey,
    );
  async function notify(job) {
    const subscriptions = await rows(
      "SELECT s.* FROM push_subscriptions s JOIN users u ON u.id=s.user_id WHERE u.active=1",
    );
    let uncertain = false;
    for (const s of subscriptions) {
      const subscription = JSON.parse(s.subscription);
      if (!validSubscription(subscription)) continue;
      try {
        await webpush.sendNotification(
          subscription,
          JSON.stringify({
            title: "ChatYemot",
            body: "הודעה חדשה בקבוצה",
            id: job.message_id,
          }),
          { TTL: 3600, timeout: 15000 },
        );
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410)
          await rows("DELETE FROM push_subscriptions WHERE id=?", [s.id]);
        else uncertain = true;
      }
    }
    if (uncertain) throw Error("Push delivery uncertain");
  }
  async function run(job) {
    const m = (
      await rows("SELECT * FROM messages WHERE id=?", [job.message_id])
    )[0];
    if (!m) return;
    if (job.type === "sync") {
      if (m.version !== job.version || (!m.media && m.kind === "audio")) return;
      const remotePath = await remote.upload(m);
      await transaction(async (c) => {
        const [updated] = await c.execute(
          "UPDATE messages SET yemot_path=?,synced_version=? WHERE id=? AND version=?",
          [remotePath, m.version, m.id, m.version],
        );
        if (updated.affectedRows && m.synced_version === 0)
          await enqueue(c, "tzintuk", m.id, 1);
      });
    }
    if (job.type === "import") {
      const temp = path.join(config.data, "tmp", random());
      let media;
      try {
        await writeFile(temp, await remote.download(job.payload));
        media = await convert(temp);
      } finally {
        await unlink(temp).catch(() => {});
      }
      await transaction(async (c) => {
        await c.execute(
          "UPDATE messages SET media=?,yemot_path=?,synced_version=version WHERE id=?",
          [media, job.payload, m.id],
        );
        await enqueueMany(c, m.id, 1, [
          { type: "push" },
          { type: "tzintuk" },
          { type: "transcribe" },
        ]);
      });
    }
    if (job.type === "tzintuk") {
      if (!m.yemot_path || m.synced_version !== m.version) return false;
      await remote.tzintuk();
    }
    if (job.type === "push")
      await (adapters.push ? adapters.push(job) : notify(job));
    if (job.type === "transcribe" && m.media && !m.transcript_manual) {
      const form = new FormData();
      form.append("model", "gpt-4o-mini-transcribe");
      form.append("language", "he");
      form.append(
        "file",
        new Blob([await readFile(mediaPath(m.media))], { type: "audio/wav" }),
        "recording.wav",
      );
      const res = await fetch(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: { authorization: "Bearer " + config.openai },
          body: form,
          signal: AbortSignal.timeout(60000),
        },
      );
      if (!res.ok) throw Error("Transcription HTTP " + res.status);
      const data = await res.json();
      await rows(
        "UPDATE messages SET transcript=? WHERE id=? AND transcript_manual=0",
        [String(data.text).slice(0, 5000), m.id],
      );
    }
  }
  async function tick() {
    const enabled = ["sync", "import"];
    if (!config.yemot.enabled && !adapters.upload) enabled.splice(0);
    if (config.yemot.tzintuk || adapters.tzintuk) enabled.push("tzintuk");
    if (pushReady || adapters.push) enabled.push("push");
    if (config.transcription && config.openai) enabled.push("transcribe");
    if (!enabled.length) return false;
    const job = await transaction(async (c) => {
      const [list] = await c.query(
        `SELECT j.* FROM jobs j WHERE j.state='pending' AND j.available_at<=NOW(3) AND j.type IN (?)
         AND (j.type<>'tzintuk' OR EXISTS (
           SELECT 1 FROM messages m WHERE m.id=j.message_id
           AND m.yemot_path IS NOT NULL AND m.synced_version=m.version
         )) ORDER BY j.id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [enabled],
      );
      if (!list[0]) return null;
      await c.execute(
        "UPDATE jobs SET state='running',attempts=attempts+1 WHERE id=?",
        [list[0].id],
      );
      return list[0];
    });
    if (!job) return false;
    try {
      if ((await run(job)) === false) {
        // An edit may have landed after claiming the job. No delivery was attempted.
        await rows("UPDATE jobs SET state='pending',attempts=attempts-1 WHERE id=?", [job.id]);
        return true;
      }
      await rows("UPDATE jobs SET state='done',error=NULL WHERE id=?", [
        job.id,
      ]);
    } catch {
      const uncertain = ["push", "tzintuk"].includes(job.type);
      await rows(
        "UPDATE jobs SET state=?,error=?,available_at=DATE_ADD(NOW(), INTERVAL 1 MINUTE) WHERE id=?",
        [
          uncertain ? "uncertain" : job.attempts >= 4 ? "failed" : "pending",
          uncertain
            ? "External delivery not confirmed"
            : "Background operation failed",
          job.id,
        ],
      );
    }
    return true;
  }
  async function loop() {
    if (stopping) return;
    current = tick();
    try {
      await current;
    } catch {
      console.error("Worker database operation failed");
    } finally {
      current = null;
      if (!stopping) timer = setTimeout(loop, 1000);
    }
  }
  return {
    tick,
    async start() {
      await rows(
        "UPDATE jobs SET state=IF(type IN ('push','tzintuk'),'uncertain','pending') WHERE state='running'",
      );
      stopping = false;
      await loop();
    },
    async stop() {
      stopping = true;
      clearTimeout(timer);
      await current;
    },
  };
}
