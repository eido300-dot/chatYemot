import { rows, db } from "../src/db.js";
import { passwordHash, normalizePhone } from "../src/security.js";
const [username, name, phone, role] = process.argv.slice(2);
try {
  if (
    !username ||
    !name ||
    !process.env.NEW_USER_PASSWORD ||
    process.env.NEW_USER_PASSWORD.length < 12
  )
    throw Error(
      "Usage: NEW_USER_PASSWORD (>=12 chars), optional NEW_USER_PIN (6-12 digits), npm run user -- username name phone [admin]",
    );
  if (process.env.NEW_USER_PIN && !/^\d{6,12}$/.test(process.env.NEW_USER_PIN))
    throw Error("PIN must contain 6-12 digits");
  await rows(
    "INSERT INTO users(username,name,phone,password_hash,pin_hash,admin) VALUES(?,?,?,?,?,?)",
    [
      username,
      name,
      phone ? normalizePhone(phone) : null,
      await passwordHash(process.env.NEW_USER_PASSWORD),
      process.env.NEW_USER_PIN
        ? await passwordHash(process.env.NEW_USER_PIN)
        : null,
      role === "admin",
    ],
  );
  console.log("User created");
} finally {
  await db.end();
}
