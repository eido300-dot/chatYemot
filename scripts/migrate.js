import { migrate, db } from "../src/db.js";
try {
  await migrate();
  console.log("Schema ready");
} finally {
  await db.end();
}
