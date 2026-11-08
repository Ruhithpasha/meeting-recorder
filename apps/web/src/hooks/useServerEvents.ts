import { useEffect, useRef, useState } from "react";
import type { ServerEvent } from "@meeting-recorder/shared";

export type Connection = "connecting" | "open" | "reconnecting" | "closed";

/**
 * Subscribes to /api/events (SSE). EventSource retries network drops by itself ("reconnecting"),
 * but gives up for good on an HTTP error such as 401 after the daemon restarted with a new token:
 * readyState CLOSED. That is reported as "closed" so the UI can say so instead of spinning forever.
 */
export function useServerEvents(onEvent: (event: ServerEvent) => void, enabled = true): Connection {
  const [connection, setConnection] = useState<Connection>("connecting");
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource("/api/events", { withCredentials: true });
    source.onopen = () => setConnection("open");
    source.onerror = () => setConnection(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    source.onmessage = (message: MessageEvent<string>) => {
      try {
        handler.current(JSON.parse(message.data) as ServerEvent);
      } catch { /* ignore malformed events */ }
    };
    return () => source.close();
  }, [enabled]);

  return connection;
}
