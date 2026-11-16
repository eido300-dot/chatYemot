import { transaction, rows } from "./db.js";
import { fail } from "./security.js";
export async function enqueue(c, type, id, version, payload = null) {
  await c.execute(
    "INSERT IGNORE INTO jobs(type,message_id,version,payload) VALUES(?,?,?,?)",
    [type, id, version, payload],
  );
}
export async function createMessage(
  user,
  {
    body = "",
    kind = "text",
    media = null,
    parentId = null,
    source = "web",
    remote = null,
  },
) {
  body = String(body).trim();
  if (body.length > 5000 || (!body && kind === "text"))
    throw fail(400, "יש להזין הודעה עד 5000 תווים");
  if (parentId && !/^\d+$/.test(String(parentId)))
    throw fail(400, "תגובה לא תקינה");
  return transaction(async (c) => {
    if (
      parentId &&
      !(await c.execute("SELECT id FROM messages WHERE id=?", [parentId]))[0]
        .length
    )
      throw fail(404, "הודעת המקור לא נמצאה");
    const [r] = await c.execute(
      "INSERT INTO messages(user_id,parent_id,kind,body,media,source) VALUES(?,?,?,?,?,?)",
      [user.id, parentId || null, kind, body, media, source],
    );
    const id = r.insertId;
    await enqueue(c, remote ? "import" : "sync", id, 1, remote);
    if (!remote) {
      await enqueue(c, "push", id, 1);
      if (kind === "audio") await enqueue(c, "transcribe", id, 1);
    }
    return id;
  });
}
export async function editMessage(user, id, { version, body, transcript }) {
  if (!Number.isSafeInteger(version) || version < 1)
    throw fail(400, "גרסה לא תקינה");
  return transaction(async (c) => {
    const m = (
      await c.execute("SELECT * FROM messages WHERE id=? FOR UPDATE", [id])
    )[0][0];
    if (!m) throw fail(404, "ההודעה לא נמצאה");
    if (m.user_id !== user.id && !user.admin) throw fail(403, "אין הרשאה");
    if (m.version !== version)
      throw fail(409, "ההודעה השתנתה. יש לרענן ולנסות שוב");
    const text = String(
      m.kind === "text" ? (body ?? m.body) : (transcript ?? m.transcript ?? ""),
    ).trim();
    if (text.length > 5000 || (!text && m.kind === "text"))
      throw fail(400, "תוכן לא תקין");
    await c.execute(
      "INSERT INTO message_versions(message_id,version,body,transcript,editor_id) VALUES(?,?,?,?,?)",
      [id, m.version, m.body, m.transcript, user.id],
    );
    await c.execute(
      "UPDATE messages SET body=?,transcript=?,transcript_manual=?,version=version+1,updated_at=NOW(3) WHERE id=?",
      [
        m.kind === "text" ? text : m.body,
        m.kind === "audio" ? text : m.transcript,
        m.kind === "audio" ? 1 : m.transcript_manual,
        id,
      ],
    );
    await enqueue(c, "sync", id, version + 1);
    return version + 1;
  });
}
export async function listMessages({ before, search } = {}) {
  const params = [];
  let where = "";
  if (before) {
    where += " AND m.id<?";
    params.push(Number(before) || 0);
  }
  if (search) {
    where += " AND (m.body LIKE ? OR m.transcript LIKE ?)";
    params.push(
      "%" + String(search).slice(0, 100) + "%",
      "%" + String(search).slice(0, 100) + "%",
    );
  }
  return rows(
    `SELECT m.id,m.user_id,m.parent_id,m.kind,m.body,m.transcript,m.version,m.synced_version,m.source,m.created_at,m.updated_at,u.name,p.body AS parent_body,p.kind AS parent_kind,pu.name AS parent_name FROM messages m JOIN users u ON u.id=m.user_id LEFT JOIN messages p ON p.id=m.parent_id LEFT JOIN users pu ON pu.id=p.user_id WHERE 1=1 ${where} ORDER BY m.id DESC LIMIT 50`,
    params,
  );
}
