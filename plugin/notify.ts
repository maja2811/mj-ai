import type { Plugin } from "@opencode-ai/plugin"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * notify plugin
 *
 * Pops a Windows toast when the agent is waiting for you:
 *   - session.idle       -> finished a turn, waiting for your next message
 *   - permission.updated -> blocked on a permission / question prompt
 *
 * The toast includes the session title and project folder so you can tell
 * which window is waiting. It is suppressed when the OpenCode host window
 * (VS Code terminal, Windows Terminal, etc.) is the foreground window.
 * Focus detection and the toast itself live in notify.ps1 (best-effort).
 */

const NOTIFY_EVENTS = new Set(["session.idle", "permission.updated"])
const DEBOUNCE_MS = 3000

export default (async ({ $, client }) => {
  const here = dirname(fileURLToPath(import.meta.url))
  const script = join(here, "notify.ps1")

  const lastBySession = new Map<string, number>()

  async function getSession(
    id: string | undefined,
  ): Promise<{ title: string; folder: string }> {
    if (!id) return { title: "", folder: "" }
    try {
      const res: any = await client.session.get({ path: { id } })
      const s = res?.data ?? res
      if (s && typeof s === "object") {
        return {
          title: typeof s.title === "string" ? s.title : "",
          folder: s.directory ? basename(String(s.directory)) : "",
        }
      }
    } catch {
      // ignore — fall back to empty labels
    }
    return { title: "", folder: "" }
  }

  return {
    event: async ({ event }) => {
      if (!NOTIFY_EVENTS.has(event.type)) return

      const props = (event as any).properties ?? {}
      const sessionID: string | undefined = props.sessionID
      const isPermission = event.type === "permission.updated"

      const now = Date.now()
      const key = sessionID ?? "-"
      if (now - (lastBySession.get(key) ?? 0) < DEBOUNCE_MS) return
      lastBySession.set(key, now)

      const { title, folder } = await getSession(sessionID)
      const label = title || folder || "session"
      const header = folder ? `OpenCode \u2014 ${folder}` : "OpenCode"

      const body = isPermission
        ? `Approval needed: ${props.title ?? "permission"}\n${label}`
        : `Finished \u2014 waiting for your reply\n${label}`

      try {
        await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ${script} -ServerPid ${String(
          process.pid,
        )} -Title ${header} -Message ${body} -MatchTitle ${folder}`.quiet()
      } catch {
        // Notifications are best-effort; never break the session over one.
      }
    },
  }
}) satisfies Plugin
