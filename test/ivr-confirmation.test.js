import assert from "node:assert/strict";
import { test } from "node:test";
import { readWithConfirmationwithArray } from "../src/ivr.js";

test("rejecting a confirmation returns to the menu within the same attempt budget", async () => {
  const answers = ["2", "2", "9", "1", "1"];
  const prompts = [];
  const call = {
    async read([message], mode, options) {
      assert.equal(mode, "tap");
      assert.deepEqual(options.digits_allowed, ["1", "2"]);
      prompts.push(message.data);
      return answers.shift();
    },
    id_list_message() {
      assert.fail("a confirmed choice should not end the call");
    },
  };

  assert.equal(
    await readWithConfirmationwithArray(call, "תַּפְרִיט", ["אֶחָד", "שְׁתַּיִם"]),
    "1",
  );
  assert.deepEqual(prompts, [
    "תַּפְרִיט לְ אֶחָד הַקֵּשׁ 1 לְ שְׁתַּיִם הַקֵּשׁ 2",
    "שְׁתַּיִם לְאִישּׁוּר הַקֵּשׁ 1 לְהַקָּשָׁה מְחוּדֶּשֶׁת 2",
    "תַּפְרִיט לְ אֶחָד הַקֵּשׁ 1 לְ שְׁתַּיִם הַקֵּשׁ 2",
    "תַּפְרִיט לְ אֶחָד הַקֵּשׁ 1 לְ שְׁתַּיִם הַקֵּשׁ 2",
    "אֶחָד לְאִישּׁוּר הַקֵּשׁ 1 לְהַקָּשָׁה מְחוּדֶּשֶׁת 2",
  ]);
});
