import {
  YemotRouter,
  HangupError,
  TimeoutError,
  ExitError,
} from "yemot-router2";
import { config } from "./config.js";
import { rows } from "./db.js";
import { verify, normalizePhone, allowedAttempt } from "./security.js";
import { createMessage } from "./messages.js";
import { validRemote } from "./yemot.js";
const text = (data) => [{ type: "text", data, removeInvalidChars: true }];
export async function readWithConfirmationwithPrompt(
  call,
  pre,
  prompt,
  filters = {},
  validate = () => true,
  secret = false,
) {
  for (let i = 0; i < 3; i++) {
    const value = await call.read(text(pre + " " + prompt), "tap", {
      ...filters,
      min_digits: 1,
      typing_playback_mode: "No",
    });
    if (!validate(value)) continue;
    const ok = await call.read(
      text(
        (secret ? "הַקּוֹד נִקְלַט" : value) +
          " לְאִישּׁוּר הַקֵּשׁ 1 לְהַקָּשָׁה מְחוּדֶּשֶׁת 2",
      ),
      "tap",
      {
        max_digits: 1,
        min_digits: 1,
        typing_playback_mode: "No",
        digits_allowed: ["1", "2"],
      },
    );
    if (ok === "1") return value;
  }
  call.id_list_message(text("יוֹתֵר מִדַּי נִסְיוֹנוֹת לְהִתְרָאוֹת"));
  return null;
}
export async function readWithConfirmationwithArray(call, pre, options) {
  const digits = options.map((_, i) => String(i + 1));
  for (let i = 0; i < 3; i++) {
    const v = await call.read(
      text(
        pre +
          " " +
          options.map((label, j) => `לְ ${label} הַקֵּשׁ ${j + 1}`).join(" "),
      ),
      "tap",
      {
        max_digits: String(options.length).length,
        min_digits: 1,
        typing_playback_mode: "No",
        digits_allowed: digits,
      },
    );
    if (!digits.includes(v)) continue;
    const ok = await call.read(
      text(
        options[Number(v) - 1] +
          " לְאִישּׁוּר הַקֵּשׁ 1 לְהַקָּשָׁה מְחוּדֶּשֶׁת 2",
      ),
      "tap",
      {
        max_digits: 1,
        min_digits: 1,
        typing_playback_mode: "No",
        digits_allowed: ["1", "2"],
      },
    );
    if (ok === "1") return v;
  }
  call.id_list_message(text("יוֹתֵר מִדַּי נִסְיוֹנוֹת לְהִתְרָאוֹת"));
  return null;
}
async function authenticate(call) {
  const phone = normalizePhone(call.phone);
  if (!(await allowedAttempt("phone:" + phone))) return null;
  const user = (
    await rows("SELECT * FROM users WHERE phone=? AND active=1", [phone])
  )[0];
  const pin = await readWithConfirmationwithPrompt(
    call,
    "",
    "נָא לְהַקִּישׁ קוֹד אִישִׁי",
    { max_digits: 12 },
    (v) => /^\d{6,12}$/.test(v),
    true,
  );
  if (!user || !pin || !(await verify(pin, user.pin_hash))) return null;
  return user;
}
async function recordMessage(call, user, parentId = null) {
  for (let i = 0; i < 3; i++) {
    const remote = await call.read(
      text("הַקְלֵט אֶת הוֹדָעָתְךָ אַחֲרֵי הַצְּפִצוּף"),
      "record",
      {
        path: config.yemot.folder,
        no_confirm_menu: false,
        save_on_hangup: false,
        max_length: 180,
        min_length: 1,
      },
    );
    if (!validRemote(remote)) continue;
    await createMessage(user, {
      kind: "audio",
      source: "phone",
      parentId,
      remote,
    });
    call.id_list_message(text("הַהוֹדָעָה נִשְׁמְרָה"), {
      prependToNextAction: true,
    });
    return;
  }
  call.id_list_message(text("הַהַקְלָטָה לֹא נִקְלְטָה"));
}
async function playMessages(call, user, onlyNew) {
  let cursor = 0;
  while (true) {
    const params = [user.id, cursor];
    const messages = await rows(
      `SELECT m.*,u.name FROM messages m JOIN users u ON u.id=m.user_id LEFT JOIN phone_reads r ON r.message_id=m.id AND r.user_id=? WHERE m.id>? AND m.yemot_path IS NOT NULL AND m.synced_version=m.version ${onlyNew ? "AND r.message_id IS NULL" : ""} ORDER BY m.id LIMIT 20`,
      params,
    );
    if (!messages.length) {
      call.id_list_message(text("אֵין הוֹדָעוֹת נוֹסָפוֹת"), {
        prependToNextAction: true,
      });
      return;
    }
    for (const m of messages) {
      cursor = m.id;
      call.id_list_message(
        [
          {
            type: "text",
            data: m.parent_id ? "תְּגוּבָה לְהוֹדָעָה" : "הוֹדָעָה",
            removeInvalidChars: true,
          },
          {
            type: "file",
            data: m.yemot_path
              .replace(/^ivr2:/, "")
              .replace(/\.(tts|wav)$/, ""),
          },
        ],
        { prependToNextAction: true },
      );
      const action = await readWithConfirmationwithArray(call, "", [
        "הַבָּאָה",
        "הַקְלָטַת תְּגוּבָה",
        "חֲזָרָה לַתַּפְרִיט",
      ]);
      await rows(
        "INSERT IGNORE INTO phone_reads(user_id,message_id) VALUES(?,?)",
        [user.id, m.id],
      );
      if (action === "2") await recordMessage(call, user, m.id);
      if (action === "3" || !action) return;
    }
  }
}
async function mainMenu(call, user) {
  for (let i = 0; i < 100; i++) {
    const choice = await readWithConfirmationwithArray(
      call,
      "תַּפְרִיט רָאשִׁי",
      [
        "הוֹדָעוֹת חֲדָשׁוֹת",
        "כָּל הַהוֹדָעוֹת",
        "הַקְלָטַת הוֹדָעָה",
        "יְצִיאָה",
      ],
    );
    if (choice === "1") await playMessages(call, user, true);
    else if (choice === "2") await playMessages(call, user, false);
    else if (choice === "3") await recordMessage(call, user);
    else return call.hangup();
  }
  call.hangup();
}
export function createIvr() {
  const router = YemotRouter({
    printLog: false,
    timeout: "5m",
    uncaughtErrorHandler: async (error, call) => {
      if (
        error instanceof HangupError ||
        error instanceof TimeoutError ||
        error instanceof ExitError
      )
        return;
      console.error("IVR handler failed");
      call.id_list_message(text("אֵרְעָה שְׁגִיאָה"));
    },
  });
  router.all("/", async (call) => {
    const user = await authenticate(call);
    if (!user) return call.id_list_message(text("הַהִזְדַּהוּת נִכְשְׁלָה"));
    return mainMenu(call, user);
  });
  return router;
}
