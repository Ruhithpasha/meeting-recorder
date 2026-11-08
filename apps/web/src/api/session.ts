export type SessionResult = "ok" | "no-session" | "rejected";

/**
 * The menu bar opens http://127.0.0.1:<port>/#t=<token>. The fragment never reaches the server or
 * its logs. We remove it from the address bar and history FIRST, then trade it for an HttpOnly
 * cookie, so the token never sits in a bookmark, a screenshot, or browser history.
 */
export async function establishSession(location: Location = window.location, history: History = window.history): Promise<SessionResult> {
  const match = /^#t=([A-Za-z0-9_-]{16,256})$/.exec(location.hash);
  if (match) {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    const response = await fetch("/api/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: match[1] }),
    });
    return response.ok ? "ok" : "rejected";
  }
  // No token in the URL: an earlier session cookie may still be valid (same daemon run).
  const response = await fetch("/api/status", { credentials: "same-origin" });
  return response.ok ? "ok" : "no-session";
}
