import path from "node:path";
const e = process.env;
export const config = {
  port: Number(e.PORT || 3000),
  production: e.NODE_ENV === "production",
  origin: e.APP_ORIGIN || "http://localhost:3000",
  data: path.resolve(e.DATA_DIR || "data"),
  db: {
    host: e.DB_HOST || "127.0.0.1",
    port: Number(e.DB_PORT || 3306),
    user: e.DB_USER || "chatyemot",
    password: e.DB_PASSWORD || "",
    database: e.DB_NAME || "chatyemot",
    charset: "utf8mb4",
    connectionLimit: 6,
    timezone: "Z",
  },
  yemot: {
    token: e.YEMOT_TOKEN,
    secret: e.YEMOT_WEBHOOK_SECRET,
    did: e.YEMOT_DID,
    folder: e.YEMOT_MEDIA_FOLDER || "/9",
    list: e.YEMOT_TZINTUK_LIST,
    enabled: e.YEMOT_ENABLED === "true",
    tzintuk: e.TZINTUK_ENABLED === "true",
  },
  push: {
    publicKey: e.VAPID_PUBLIC_KEY,
    privateKey: e.VAPID_PRIVATE_KEY,
    subject: e.VAPID_SUBJECT || "mailto:admin@example.com",
  },
  transcription: e.TRANSCRIPTION_ENABLED === "true",
  openai: e.OPENAI_API_KEY,
};
if (config.production && !e.APP_ORIGIN?.startsWith("https://"))
  throw Error("APP_ORIGIN must use HTTPS in production");
if (
  config.yemot.enabled &&
  (!config.yemot.token ||
    !config.yemot.did ||
    !config.yemot.secret ||
    config.yemot.secret.length < 32 ||
    !/^\/[0-9/]+$/.test(config.yemot.folder))
)
  throw Error("Incomplete Yemot configuration");
