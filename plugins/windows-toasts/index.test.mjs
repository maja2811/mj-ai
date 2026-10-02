import assert from "node:assert/strict";
import { test } from "node:test";
import plugin, { createHandler } from "./index.mjs";

const directory = "C:\\work\\example-project";

test("native alerts identify the project/session and suppress duplicate requests", async () => {
  const calls = [];
  const context = {
    location: { directory },
    session: { get: async () => ({ title: "Fix widgets", location: { directory } }) },
  };
  const handle = createHandler(context, async (...args) => calls.push(args));
  const events = [
    { id: "evt_done", type: "session.execution.succeeded", data: { sessionID: "ses_main" } },
    { id: "evt_permission", type: "permission.asked", data: { sessionID: "ses_main", id: "perm_1" } },
    { id: "evt_question", type: "form.created", data: { form: { sessionID: "ses_main", id: "frm_1" } } },
    { id: "evt_failed", type: "session.execution.failed", data: { sessionID: "ses_main" } },
  ];
  for (const event of events) {
    await handle(event);
    await handle(event);
  }
  await handle({ ...events[1], id: "evt_repeated_request" });
  assert.equal(calls.length, 4);
  assert.ok(calls.every(([title, body]) => title === "OpenCode - example-project" && body.startsWith("Fix widgets\n")));
  assert.deepEqual(calls.map(([, body]) => body.split("\n")[1]), [
    "Session done", "Permission needs input", "Question needs a response", "Session failed",
  ]);
  await handle({ ...events[0], id: "evt_next_turn" });
  assert.equal(calls.length, 5);
});

test("other locations, global forms and subagent completions do not produce alerts", async () => {
  const calls = [];
  let reads = 0;
  const context = {
    location: { directory },
    session: { get: async ({ sessionID }) => {
      reads++;
      return { parentID: sessionID === "ses_child" ? "ses_main" : undefined,
        location: { directory: sessionID === "ses_other" ? "C:\\work\\other" : directory } };
    } },
  };
  const handle = createHandler(context, async (...args) => calls.push(args));
  await handle({ type: "session.execution.succeeded", location: { directory: "C:\\work\\other" }, data: { sessionID: "ses_other" } });
  await handle({ type: "form.created", data: { form: { sessionID: "global" } } });
  assert.equal(reads, 0);
  await handle({ id: "evt_other", type: "session.execution.succeeded", data: { sessionID: "ses_other" } });
  await handle({ id: "evt_child", type: "session.execution.succeeded", data: { sessionID: "ses_child" } });
  assert.equal(calls.length, 0);
  await handle({ id: "evt_child_permission", type: "permission.asked", data: { sessionID: "ses_child", id: "perm_child" } });
  assert.equal(calls.length, 1);
});

test("failed delivery can retry instead of permanently suppressing the alert", async () => {
  let attempts = 0;
  const handle = createHandler({
    location: { directory },
    session: { get: async () => ({ location: { directory } }) },
  }, async () => { if (++attempts === 1) throw new Error("delivery failed"); });
  const event = { id: "evt_retry", type: "session.execution.succeeded", data: { sessionID: "ses_main" } };
  await assert.rejects(handle(event), /delivery failed/);
  await handle(event);
  assert.equal(attempts, 2);
});

test("server event subscription is aborted when the plugin unloads", async () => {
  let signal;
  const cleanup = plugin.setup({
    location: { directory },
    event: { subscribe: async function* (options) {
      signal = options.signal;
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    } },
  });
  await cleanup();
  assert.ok(signal.aborted);
});
