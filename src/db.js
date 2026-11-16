import mysql from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { config } from "./config.js";
export const db = mysql.createPool(config.db);
export async function transaction(fn) {
  const c = await db.getConnection();
  try {
    await c.beginTransaction();
    const result = await fn(c);
    await c.commit();
    return result;
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}
export async function migrate() {
  const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  for (const statement of sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await db.query(statement);
}
export async function rows(sql, args = []) {
  return (await db.execute(sql, args))[0];
}
