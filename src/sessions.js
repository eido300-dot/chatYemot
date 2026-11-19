import express from "express";
import { rateLimit } from "express-rate-limit";
import { config } from "./config.js";
import { rows } from "./db.js";
import { wrap } from "./http.js";
import { allowedAttempt, fail, hash, random, validPassword, verify } from "./security.js";

const cookieName = "session";
const cookiePath = "/";
const lifetimeDays = 7;
const userColumns = "u.id,u.name,u.admin,u.last_read";

function publicUser({ id, name, admin, last_read }) {
  return { id, name, admin: !!admin, last_read };
}

async function login(req, res) {
  const { username, password } = req.body;
  if (typeof username !== "string" || !validPassword(password))
    throw fail(400, "פרטים לא תקינים");
  if (!(await allowedAttempt("web:" + username.toLowerCase())))
    throw fail(429, "יש להמתין לפני ניסיון נוסף");
  const [user] = await rows(
    `SELECT ${userColumns},u.password_hash FROM users u WHERE u.username=? AND u.active=1`,
    [username],
  );
  if (!user || !(await verify(password, user.password_hash)))
    throw fail(401, "שם משתמש או סיסמה שגויים");
  const token = random();
  const csrf = random();
  await rows(
    "INSERT INTO sessions(token,user_id,csrf,expires_at) VALUES(?,?,?,DATE_ADD(NOW(), INTERVAL ? DAY))",
    [hash(token), user.id, csrf, lifetimeDays],
  );
  res.cookie(cookieName, token, {
    httpOnly: true,
    secure: config.production,
    sameSite: "strict",
    maxAge: lifetimeDays * 86400000,
    path: cookiePath,
  });
  res.json({ csrf, user: publicUser(user) });
}

async function authenticate(req, res, next) {
  const token = req.cookies[cookieName];
  if (!token) throw fail(401, "נדרשת כניסה");
  const tokenHash = hash(token);
  const [session] = await rows(
    `SELECT s.csrf,${userColumns} FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>NOW() AND u.active=1`,
    [tokenHash],
  );
  if (!session) throw fail(401, "נדרשת כניסה");
  if (!["GET", "HEAD"].includes(req.method) && req.get("x-csrf-token") !== session.csrf)
    throw fail(403, "אימות הבקשה נכשל");
  req.user = publicUser(session);
  res.locals.session = { tokenHash, csrf: session.csrf };
  next();
}

export function createSessionRouter() {
  const router = express.Router();
  router.post("/login", rateLimit({ windowMs: 15 * 60000, limit: 30 }), wrap(login));
  router.use(wrap(authenticate));
  router.get("/me", (req, res) =>
    res.json({ user: req.user, csrf: res.locals.session.csrf }),
  );
  router.post("/logout", wrap(async (req, res) => {
    await rows("DELETE FROM sessions WHERE token=?", [res.locals.session.tokenHash]);
    res.clearCookie(cookieName, { path: cookiePath }).json({ ok: true });
  }));
  return router;
}
