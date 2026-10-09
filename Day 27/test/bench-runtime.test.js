import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { askWithRetry } from "../scripts/lib/bench-runtime.js";

describe("bench-runtime askWithRetry", () => {
  it("retries until success", async () => {
    let calls = 0;
    const agent = {
      name: "t",
      ask: async () => {
        calls += 1;
        if (calls < 2) throw new Error("fail");
        return { reply: "ok" };
      },
    };
    const result = await askWithRetry(agent, "q", {}, 3);
    assert.equal(result.reply, "ok");
    assert.equal(calls, 2);
  });
});
