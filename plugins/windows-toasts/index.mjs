import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../../skills/review-pr/scripts/notify.ps1", import.meta.url));
const messages = {
  "session.execution.succeeded": "Session done",
  "session.execution.failed": "Session failed",
  "permission.asked": "Permission needs input",
  "form.created": "Question needs a response",
};

export async function showToast(title, message) {
  await run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", script, "-Title", title, "-Message", message,
    "-AppId", "Microsoft.PowerShell_8wekyb3d8bbwe!App",
  ], { windowsHide: true, timeout: 15000 });
}

const directoryKey = (directory) => path.resolve(directory).toLowerCase();

export function createHandler(context, notify = showToast) {
  const seen = new Set();
  return async (event) => {
    const message = messages[event.type];
    if (!message) return;
    // Every location has a plugin instance, but the event stream is server-wide.
    if (event.location && directoryKey(event.location.directory) !== directoryKey(context.location.directory)) return;
    const sessionID = event.data.form?.sessionID ?? event.data.sessionID;
    if (!sessionID || sessionID === "global") return;
    const session = await context.session.get({ sessionID });
    if (directoryKey(session.location.directory) !== directoryKey(context.location.directory)) return;
    if (session.parentID && event.type.startsWith("session.execution.")) return;
    const key = `${event.type}:${event.data.form?.id ?? event.data.id ?? event.id}`;
    if (seen.has(key)) return;
    await notify(
      `OpenCode - ${path.basename(session.location.directory)}`,
      `${session.title || sessionID}\n${message}`,
    );
    seen.add(key);
    // Bound duplicate suppression; notifications are live events, not a history replay.
    if (seen.size > 256) seen.delete(seen.values().next().value);
  };
}

export default {
  id: "local.windows-toasts",
  setup(context) {
    if (process.platform !== "win32") return;
    const controller = new AbortController();
    const handle = createHandler(context);
    const listening = (async () => {
      for await (const event of context.event.subscribe({ signal: controller.signal })) {
        try {
          await handle(event);
        } catch (error) {
          console.error("Windows toast failed", error);
        }
      }
    })().catch((error) => {
      if (!controller.signal.aborted) console.error("Windows toast event stream failed", error);
    });
    return async () => {
      controller.abort();
      await listening;
    };
  },
};
