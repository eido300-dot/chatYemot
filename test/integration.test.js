import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import path from "node:path";
if (!process.env.TEST_DB_NAME?.endsWith("_test"))
  throw Error(
    "Set TEST_DB_NAME ending in _test (destructive tests use only this database)",
  );
process.env.DB_NAME = process.env.TEST_DB_NAME;
process.env.DB_PORT = process.env.TEST_DB_PORT || "3307";
process.env.YEMOT_ENABLED = "true";
process.env.YEMOT_TOKEN = "test";
process.env.YEMOT_DID = "0770000000";
process.env.YEMOT_WEBHOOK_SECRET = "test-secret-000000000000000000000000";
process.env.DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "chatyemot-test-"));
const { db, rows, migrate } = await import("../src/db.js");
const { passwordHash, validSubscription } = await import("../src/security.js");
const { createApp } = await import("../src/app.js");
const { createWorker } = await import("../src/worker.js");
const { readWithConfirmationwithArray } = await import("../src/ivr.js");
const { config } = await import("../src/config.js");
let server, base, alice, bob, csrf, cookie, id, audioId;
async function request(url, method = "GET", body, auth = true) {
  const headers = { Origin: config.origin };
  if (auth) {
    headers.Cookie = cookie;
    headers["X-CSRF-Token"] = csrf;
  }
  if (body && !(body instanceof FormData))
    headers["Content-Type"] = "application/json";
  return fetch(base + url, {
    method,
    headers,
    body:
      body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
}
before(async () => {
  await migrate();
  await db.query("SET FOREIGN_KEY_CHECKS=0");
  for (const t of [
    "jobs",
    "message_versions",
    "phone_reads",
    "messages",
    "push_subscriptions",
    "sessions",
    "users",
    "auth_attempts",
  ])
    await db.query("TRUNCATE TABLE " + t);
  await db.query("SET FOREIGN_KEY_CHECKS=1");
  for (const [username, name, phone] of [
    ["alice", "אליס", "0500000001"],
    ["bob", "בוב", "0500000002"],
  ])
    await rows(
      "INSERT INTO users(username,name,phone,password_hash,pin_hash) VALUES(?,?,?,?,?)",
      [
        username,
        name,
        phone,
        await passwordHash("test-password-123"),
        await passwordHash("123456"),
      ],
    );
  alice = (await rows("SELECT * FROM users WHERE username='alice'"))[0];
  bob = (await rows("SELECT * FROM users WHERE username='bob'"))[0];
  server = (await createApp()).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
  await rm(process.env.DATA_DIR, { recursive: true, force: true });
});
test("authentication, origin and CSRF", async () => {
  assert.equal(
    (await request("/api/messages", "GET", null, false)).status,
    401,
  );
  const wrong = await fetch(base + "/api/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://evil.example",
    },
    body: JSON.stringify({ username: "alice", password: "test-password-123" }),
  });
  assert.equal(wrong.status, 403);
  const login = await request(
    "/api/login",
    "POST",
    { username: "alice", password: "test-password-123" },
    false,
  );
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  csrf = (await login.json()).csrf;
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  const blocked = await fetch(base + "/api/messages", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: config.origin,
      "Content-Type": "application/json",
    },
    body: '{"body":"blocked"}',
  });
  assert.equal(blocked.status, 403);
});
test("CLI and login share the 12–256 character password policy", async () => {
  const run = promisify(execFile);
  for (const length of [11, 257]) {
    await assert.rejects(run(process.execPath, ["scripts/user.js", "rejected_" + length, "Rejected"], {
      env: { ...process.env, NEW_USER_PASSWORD: "p".repeat(length), NEW_USER_PIN: "" },
    }), "CLI must reject a " + length + " character password");
    assert.equal((await request("/api/login", "POST", {
      username: "rejected_" + length, password: "p".repeat(length),
    }, false)).status, 400);
  }
  for (const length of [12, 256]) {
    await run(process.execPath, ["scripts/user.js", "accepted_" + length, "Accepted"], {
      env: { ...process.env, NEW_USER_PASSWORD: "p".repeat(length), NEW_USER_PIN: "" },
    });
    assert.equal((await request("/api/login", "POST", {
      username: "accepted_" + length, password: "p".repeat(length),
    }, false)).status, 200);
  }
});
test("messages, replies, edits, conflicts, ownership, versions and search", async () => {
  let res = await request("/api/messages", "POST", { body: "שלום מהאתר" });
  assert.equal(res.status, 201);
  id = (await res.json()).id;
  assert.equal(
    (await request("/api/messages", "POST", { body: "תגובה", parentId: id }))
      .status,
    201,
  );
  assert.equal(
    (
      await request("/api/messages/" + id, "PATCH", {
        body: "שלום מתוקן",
        version: 1,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/messages/" + id, "PATCH", {
        body: "התנגשות",
        version: 1,
      })
    ).status,
    409,
  );
  const versions = await (
    await request("/api/messages/" + id + "/versions")
  ).json();
  assert.equal(versions[0].body, "שלום מהאתר");
  const results = await (
    await request("/api/messages?search=" + encodeURIComponent("מתוקן"))
  ).json();
  assert.equal(results[0].id, id);
  const { createMessage, editMessage } = await import("../src/messages.js");
  const other = await createMessage(bob, { body: "של בוב" });
  await assert.rejects(
    editMessage(alice, other, { version: 1, body: "אין הרשאה" }),
    { status: 403 },
  );
  assert.equal(
    (await request("/api/messages", "POST", { body: "תגובה", parentId: 99999 }))
      .status,
    404,
  );
});
function wav() {
  const b = Buffer.alloc(16044);
  b.write("RIFF");
  b.writeUInt32LE(16036, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(16000, 40);
  return b;
}
test("real audio conversion, authenticated playback and manual transcript", async () => {
  const form = new FormData();
  form.append("audio", new Blob([wav()], { type: "audio/wav" }), "test.wav");
  const res = await request("/api/audio", "POST", form);
  assert.equal(res.status, 201);
  audioId = (await res.json()).id;
  const audio = await request("/api/messages/" + audioId + "/audio");
  assert.equal(audio.status, 200);
  assert.equal(
    Buffer.from(await audio.arrayBuffer()).toString("ascii", 0, 4),
    "RIFF",
  );
  assert.equal(
    (await request("/api/messages/" + audioId + "/audio", "GET", null, false))
      .status,
    401,
  );
  assert.equal(
    (
      await request("/api/messages/" + audioId, "PATCH", {
        version: 1,
        transcript: "תמלול ידני",
      })
    ).status,
    200,
  );
});
test("durable sync uses latest version and sends tzintuk only after upload", async () => {
  const events = [];
  const worker = createWorker({
    upload: async (m) => {
      events.push("upload:" + m.id + ":" + m.version);
      return (
        "ivr2:/9/" +
        m.id +
        "v" +
        m.version +
        "." +
        (m.kind === "text" ? "tts" : "wav")
      );
    },
    push: async () => {},
    tzintuk: async () => events.push("tzintuk"),
  });
  while (await worker.tick()) {}
  const m = (await rows("SELECT * FROM messages WHERE id=?", [id]))[0];
  assert.equal(m.synced_version, 2);
  assert.equal(events.includes("upload:" + id + ":1"), false);
  assert.ok(events.includes("upload:" + id + ":2"));
  const a = (await rows("SELECT * FROM messages WHERE id=?", [audioId]))[0];
  assert.equal(a.synced_version, 2);
  assert.equal(a.transcript, "תמלול ידני");
  assert.ok(
    events.indexOf("tzintuk") >
      events.findIndex((x) => x.startsWith("upload:")),
  );
});
test("ambiguous tzintuk is not retried", async () => {
  const { createMessage } = await import("../src/messages.js");
  const newId = await createMessage(alice, { body: "צינתוק" });
  let calls = 0;
  const worker = createWorker({
    upload: async () => "ivr2:/9/555.tts",
    push: async () => {},
    tzintuk: async () => {
      calls++;
      throw Error("network timeout");
    },
  });
  while (await worker.tick()) {}
  assert.equal(calls, 1);
  assert.equal(
    (
      await rows(
        "SELECT state FROM jobs WHERE type='tzintuk' AND message_id=?",
        [newId],
      )
    )[0].state,
    "uncertain",
  );
  assert.equal(await worker.tick(), false);
});
test("queued tzintuk waits for the current version and edits never notify again", async () => {
  const events = [];
  const worker = createWorker({
    upload: async (m) => {
      events.push("upload:" + m.version);
      return "ivr2:/9/" + m.id + "v" + m.version + ".tts";
    },
    push: async () => {},
    tzintuk: async () => events.push("tzintuk"),
  });
  const created = await request("/api/messages", "POST", { body: "ממתין לקו" });
  const messageId = (await created.json()).id;
  assert.equal(await worker.tick(), true); // Publish v1, enqueue notification.
  assert.deepEqual(events, ["upload:1"]);
  assert.equal((await request("/api/messages/" + messageId, "PATCH", {
    version: 1, body: "גרסה עדכנית לקו",
  })).status, 200);
  while (await worker.tick()) {}
  assert.deepEqual(events, ["upload:1", "upload:2", "tzintuk"]);
  assert.equal((await request("/api/messages/" + messageId, "PATCH", {
    version: 2, body: "עוד עריכה ללא התראה",
  })).status, 200);
  while (await worker.tick()) {}
  assert.deepEqual(events, ["upload:1", "upload:2", "tzintuk", "upload:3"]);
});
test("IVR invalid menu attempts are bounded", async () => {
  let attempts = 0;
  const call = {
    read: async () => {
      attempts++;
      return "9";
    },
    id_list_message: () => {
      throw Error("terminated");
    },
  };
  await assert.rejects(
    readWithConfirmationwithArray(call, "", ["אֶחָד"]),
    /terminated/,
  );
  assert.equal(attempts, 3);
});
test("actual yemot HTTP PIN and main menu, form encoded", async () => {
  let count = 0;
  const callId = "test-call";
  const fields = {
    ApiCallId: callId,
    ApiDID: config.yemot.did,
    ApiPhone: "0500000001",
    ApiExtension: "1",
  };
  async function step(values = {}) {
    count++;
    const r = await fetch(base + "/ivr/" + config.yemot.secret, {
      method: "POST",
      body: new URLSearchParams({ ...fields, ...values }),
    });
    assert.equal(r.status, 200);
    return r.text();
  }
  let response = await step();
  assert.match(response, /read=/);
  assert.match(response, /val_1/);
  response = await step({ val_1: "123456" });
  assert.ok(!response.includes("123456"));
  assert.match(response, /val_2/);
  response = await step({ val_2: "1" });
  assert.match(response, /תַּפְרִיט/);
  response = await step({ val_3: "4" });
  assert.match(response, /val_4/);
  response = await step({ val_4: "1" });
  assert.match(response, /hangup/);
  assert.equal(count, 5);
  const r = await fetch(base + "/ivr/" + config.yemot.secret, {
    method: "POST",
    body: new URLSearchParams({ ...fields, ApiDID: "wrong" }),
  });
  assert.equal(r.status, 403);
});
test("actual IVR recording HTTP creates an import task", async () => {
  const fields = {
    ApiCallId: "record-call",
    ApiDID: config.yemot.did,
    ApiPhone: "0500000001",
    ApiExtension: "1",
  };
  async function step(values = {}) {
    const r = await fetch(base + "/ivr/" + config.yemot.secret, {
      method: "POST",
      body: new URLSearchParams({ ...fields, ...values }),
    });
    return r.text();
  }
  await step();
  await step({ val_1: "123456" });
  await step({ val_2: "1" });
  await step({ val_3: "3" });
  let response = await step({ val_4: "1" });
  assert.match(response, /,record,/);
  response = await step({ val_5: "/9/002.wav" });
  assert.match(response, /read=/);
  const jobs = await rows(
    "SELECT j.* FROM jobs j JOIN messages m ON m.id=j.message_id WHERE j.type='import' AND j.payload='/9/002.wav'",
  );
  assert.equal(jobs.length, 1);
  await step({ hangup: "yes" });
});
test("phone recording is imported, converted and visible on web", async () => {
  const { createMessage } = await import("../src/messages.js");
  const phoneId = await createMessage(alice, {
    kind: "audio",
    source: "phone",
    remote: "/9/001.wav",
    parentId: id,
  });
  const worker = createWorker({
    download: async () => wav(),
    upload: async () => "ivr2:/9/001.wav",
    push: async () => {},
    tzintuk: async () => {},
  });
  while (await worker.tick()) {}
  const m = (await rows("SELECT * FROM messages WHERE id=?", [phoneId]))[0];
  assert.ok(m.media);
  assert.equal(m.source, "phone");
  assert.equal(
    (await request("/api/messages/" + phoneId + "/audio")).status,
    200,
  );
  assert.equal(m.parent_id, id);
});
test("rejects arbitrary push hosts and tracks reads", async () => {
  assert.equal(
    validSubscription({
      endpoint: "https://127.0.0.1/push",
      keys: { auth: "a", p256dh: "b" },
    }),
    false,
  );
  assert.equal(
    (
      await request("/api/push", "POST", {
        endpoint: "https://evil.example/push",
      })
    ).status,
    400,
  );
  const marked = await request("/api/read", "POST", { id });
  assert.equal(marked.status, 200);
  assert.deepEqual(await marked.json(), { ok: true, last_read: id });
  assert.equal((await (await request("/api/me")).json()).user.last_read, id);
  const newest = await request("/api/messages", "POST", { body: "נקראה" });
  assert.equal(newest.status, 201);
  const { id: latest } = await newest.json();
  const [high, low] = await Promise.all([
    request("/api/read", "POST", { id: Number.MAX_SAFE_INTEGER }),
    request("/api/read", "POST", { id: 0 }),
  ]);
  assert.deepEqual(await high.json(), { ok: true, last_read: latest });
  assert.ok([id, latest].includes((await low.json()).last_read));
  const after = await request("/api/read", "POST", { id: 0 });
  assert.deepEqual(await after.json(), { ok: true, last_read: latest });
});
test("logout invalidates session", async () => {
  assert.equal((await request("/api/logout", "POST")).status, 200);
  assert.equal((await request("/api/me")).status, 401);
});
