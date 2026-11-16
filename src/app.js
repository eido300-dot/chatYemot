import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { config } from "./config.js";
import { rows } from "./db.js";
import {
  hash,
  random,
  verify,
  allowedAttempt,
  fail,
  validSubscription,
} from "./security.js";
import { listMessages, createMessage, editMessage } from "./messages.js";
import { prepareMedia, convert, mediaPath } from "./media.js";
import { createIvr } from "./ivr.js";
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
export async function createApp() {
  await prepareMedia();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          mediaSrc: ["'self'", "blob:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: config.production ? [] : null,
        },
      },
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: "32kb" }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.get(
    "/health",
    wrap(async (req, res) => {
      await rows("SELECT 1");
      res.json({ ok: true });
    }),
  );
  if (config.yemot.enabled) {
    const ivr = createIvr();
    app.use(
      "/ivr/" + config.yemot.secret,
      (req, res, next) => {
        if (String(req.body.ApiDID || req.query.ApiDID) !== config.yemot.did)
          return res.sendStatus(403);
        next();
      },
      ivr.asExpressRouter,
    );
  }
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 180,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
    (req, res, next) => {
      res.set("Cache-Control", "no-store");
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        req.get("origin") !== config.origin
      )
        return next(fail(403, "מקור הבקשה אינו מורשה"));
      next();
    },
  );
  app.get("/api/config", (req, res) =>
    res.json({ pushKey: config.push.publicKey || null }),
  );
  app.post(
    "/api/login",
    rateLimit({ windowMs: 15 * 60000, limit: 30 }),
    wrap(async (req, res) => {
      const { username, password } = req.body;
      if (
        typeof username !== "string" ||
        typeof password !== "string" ||
        password.length > 256
      )
        throw fail(400, "פרטים לא תקינים");
      if (!(await allowedAttempt("web:" + username.toLowerCase())))
        throw fail(429, "יש להמתין לפני ניסיון נוסף");
      const u = (
        await rows("SELECT * FROM users WHERE username=? AND active=1", [
          username,
        ])
      )[0];
      if (!u || !(await verify(password, u.password_hash)))
        throw fail(401, "שם משתמש או סיסמה שגויים");
      const token = random(),
        csrf = random();
      await rows(
        "INSERT INTO sessions(token,user_id,csrf,expires_at) VALUES(?,?,?,DATE_ADD(NOW(), INTERVAL 7 DAY))",
        [hash(token), u.id, csrf],
      );
      res.cookie("session", token, {
        httpOnly: true,
        secure: config.production,
        sameSite: "strict",
        maxAge: 7 * 86400000,
        path: "/",
      });
      res.json({
        csrf,
        user: {
          id: u.id,
          name: u.name,
          admin: !!u.admin,
          last_read: u.last_read,
        },
      });
    }),
  );
  app.use(
    "/api",
    wrap(async (req, res, next) => {
      const token = req.cookies.session;
      if (!token) throw fail(401, "נדרשת כניסה");
      const s = (
        await rows(
          "SELECT s.*,u.name,u.admin,u.active,u.last_read FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>NOW() AND u.active=1",
          [hash(token)],
        )
      )[0];
      if (!s) throw fail(401, "נדרשת כניסה");
      req.user = {
        id: s.user_id,
        name: s.name,
        admin: !!s.admin,
        last_read: s.last_read,
      };
      req.session = s;
      if (
        !["GET", "HEAD"].includes(req.method) &&
        req.get("x-csrf-token") !== s.csrf
      )
        throw fail(403, "אימות הבקשה נכשל");
      next();
    }),
  );
  app.get("/api/me", (req, res) =>
    res.json({ user: req.user, csrf: req.session.csrf }),
  );
  app.post(
    "/api/logout",
    wrap(async (req, res) => {
      await rows("DELETE FROM sessions WHERE token=?", [req.session.token]);
      res.clearCookie("session", { path: "/" }).json({ ok: true });
    }),
  );
  app.get(
    "/api/messages",
    wrap(async (req, res) => res.json(await listMessages(req.query))),
  );
  const sendLimit = rateLimit({ windowMs: 60000, limit: 20 });
  app.post(
    "/api/messages",
    sendLimit,
    wrap(async (req, res) =>
      res
        .status(201)
        .json({
          id: await createMessage(req.user, {
            body: req.body.body,
            parentId: req.body.parentId,
          }),
        }),
    ),
  );
  const upload = multer({
    dest: path.join(config.data, "tmp"),
    limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 2 },
  });
  app.post(
    "/api/audio",
    sendLimit,
    upload.single("audio"),
    wrap(async (req, res) => {
      if (!req.file) throw fail(400, "יש לצרף קובץ שמע");
      let name;
      try {
        name = await convert(req.file.path);
        const id = await createMessage(req.user, {
          kind: "audio",
          media: name,
          parentId: req.body.parentId,
        });
        res.status(201).json({ id });
      } catch (e) {
        if (name) await unlink(mediaPath(name)).catch(() => {});
        throw e;
      } finally {
        await unlink(req.file.path).catch(() => {});
      }
    }),
  );
  app.get(
    "/api/messages/:id/audio",
    wrap(async (req, res) => {
      const m = (
        await rows("SELECT media FROM messages WHERE id=?", [req.params.id])
      )[0];
      if (!m?.media) throw fail(404, "ההקלטה אינה זמינה");
      res.set("Cache-Control", "private, no-store");
      res.sendFile(mediaPath(m.media));
    }),
  );
  app.patch(
    "/api/messages/:id",
    wrap(async (req, res) =>
      res.json({
        version: await editMessage(req.user, req.params.id, req.body),
      }),
    ),
  );
  app.get(
    "/api/messages/:id/versions",
    wrap(async (req, res) => {
      const m = (
        await rows("SELECT user_id FROM messages WHERE id=?", [req.params.id])
      )[0];
      if (!m) throw fail(404, "לא נמצא");
      if (m.user_id !== req.user.id && !req.user.admin)
        throw fail(403, "אין הרשאה");
      res.json(
        await rows(
          "SELECT version,body,transcript,created_at FROM message_versions WHERE message_id=? ORDER BY version DESC",
          [req.params.id],
        ),
      );
    }),
  );
  app.post(
    "/api/read",
    wrap(async (req, res) => {
      const id = Number(req.body.id);
      if (!Number.isSafeInteger(id) || id < 0) throw fail(400, "מזהה לא תקין");
      await rows(
        "UPDATE users SET last_read=GREATEST(last_read,LEAST(?,(SELECT COALESCE(MAX(id),0) FROM messages))) WHERE id=?",
        [id, req.user.id],
      );
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/push",
    wrap(async (req, res) => {
      if (!validSubscription(req.body)) throw fail(400, "יעד פוש אינו תקין");
      await rows(
        "INSERT INTO push_subscriptions(user_id,endpoint_hash,subscription) VALUES(?,?,?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),subscription=VALUES(subscription)",
        [req.user.id, hash(req.body.endpoint), JSON.stringify(req.body)],
      );
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/push",
    wrap(async (req, res) => {
      await rows(
        "DELETE FROM push_subscriptions WHERE user_id=? AND endpoint_hash=?",
        [req.user.id, hash(String(req.body.endpoint))],
      );
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/admin",
    wrap(async (req, res) => {
      if (!req.user.admin) throw fail(403, "אין הרשאה");
      res.json({
        users: await rows("SELECT id,username,name,active,admin FROM users"),
        jobs: await rows(
          "SELECT type,state,COUNT(*) AS count FROM jobs GROUP BY type,state",
        ),
      });
    }),
  );
  app.use("/api", (req, res) => res.sendStatus(404));
  app.use(
    express.static(new URL("../public/", import.meta.url).pathname, {
      etag: true,
    }),
  );
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : error.status || 500;
    if (status >= 500)
      console.error("Request failed:", error.code || error.name);
    res
      .status(status)
      .json({
        error:
          status >= 500
            ? "אירעה שגיאה בשרת"
            : status === 413
              ? "הקובץ גדול מדי"
              : error.message,
      });
  });
  return app;
}
