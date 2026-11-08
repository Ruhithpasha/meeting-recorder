import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { DEFAULT_SETTINGS } from "@meeting-recorder/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { FakeEventSource, json, meeting, mockFetch, status } from "./test/fixtures.ts";

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  window.history.replaceState(null, "", "/");
});
afterEach(() => vi.unstubAllGlobals());

const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

describe("App", () => {
  it("without a session, tells the user to open the dashboard from the menu bar", async () => {
    mockFetch({ "GET /api/status": () => json({ error: "Unauthorized" }, { status: 401 }) });
    render(<App />);
    expect(await screen.findByText("Open the dashboard from Meeting Recorder")).toBeInTheDocument();
  });

  it("with a token link: strips it from the URL, loads meetings, and applies live events", async () => {
    window.history.replaceState(null, "", `/#t=${TOKEN}`);
    mockFetch({
      "POST /api/session": () => new Response(null, { status: 204 }),
      "GET /api/meetings": () => json({ items: [meeting(2), meeting(1)], nextCursor: null }),
    });
    render(<App />);
    const list = await screen.findByRole("region", { name: "Meetings" });
    expect(within(list).getByText("Meeting 2")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Meeting 2" })).toBeInTheDocument(); // newest opens automatically (effect)
    expect(window.location.hash).toBe("");

    const events = FakeEventSource.instances[0]!;
    act(() => {
      events.onopen?.();
      events.emit({ type: "status", status: status({ state: "recording", meetingId: meeting(3).id }) });
      events.emit({ type: "meeting", meeting: meeting(3, { status: "recording" }) });
    });
    expect(within(screen.getByRole("region", { name: "Meetings" })).getByText("Meeting 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    act(() => events.emit({ type: "meetingDeleted", id: meeting(1).id }));
    expect(within(screen.getByRole("region", { name: "Meetings" })).queryByText("Meeting 1")).toBeNull();
  });

  it("shows a reconnecting notice when the event stream drops", async () => {
    mockFetch({ "GET /api/status": () => json(status()), "GET /api/meetings": () => json({ items: [], nextCursor: null }) });
    render(<App />);
    await screen.findByText("No recordings yet");
    act(() => FakeEventSource.instances[0]!.onerror?.());
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
  });

  it("refetches the list when the event stream reconnects (missed events)", async () => {
    let page = { items: [meeting(1, { status: "recording" })], nextCursor: null };
    mockFetch({ "GET /api/status": () => json(status()), "GET /api/meetings": () => json(page) });
    render(<App />);
    expect(await screen.findByText("Recording", { selector: "[data-slot=badge]" })).toBeInTheDocument();
    const events = FakeEventSource.instances[0]!;
    act(() => events.onopen?.());
    page = { items: [meeting(1, { status: "complete" })], nextCursor: null };
    act(() => events.onerror?.());
    act(() => events.onopen?.());
    await waitFor(() => expect(screen.queryByText("Recording", { selector: "[data-slot=badge]" })).toBeNull());
  });

  it("tells the user to reopen from the menu bar when the stream is closed for good (new token)", async () => {
    mockFetch({ "GET /api/status": () => json(status()), "GET /api/meetings": () => json({ items: [], nextCursor: null }) });
    render(<App />);
    await screen.findByText("No recordings yet");
    const events = FakeEventSource.instances[0]!;
    act(() => { (events as unknown as { readyState: number }).readyState = 2; events.onerror?.(); });
    expect(screen.getByText("This dashboard session has ended")).toBeInTheDocument();
  });

  it("a delete confirmation does not carry over to another meeting", async () => {
    mockFetch({ "GET /api/status": () => json(status()), "GET /api/meetings": () => json({ items: [meeting(2), meeting(1)], nextCursor: null }) });
    render(<App />);
    const list = await screen.findByRole("region", { name: "Meetings" });
    await userEvent.click(within(list).getByText("Meeting 2"));
    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    expect(screen.getByRole("button", { name: "Move to Trash" })).toBeInTheDocument();
    await userEvent.click(within(list).getByText("Meeting 1"));
    expect(screen.queryByRole("button", { name: "Move to Trash" })).toBeNull();
  });

  it("a new recording arriving doesn't switch the player away from the meeting being watched", async () => {
    mockFetch({ "GET /api/status": () => json(status()), "GET /api/meetings": () => json({ items: [meeting(2), meeting(1)], nextCursor: null }) });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Meeting 2" })).toBeInTheDocument(); // auto-opened
    act(() => FakeEventSource.instances[0]!.emit({ type: "meeting", meeting: meeting(5, { status: "recording" }) }));
    expect(screen.getByRole("heading", { name: "Meeting 2" })).toBeInTheDocument();
  });

  it("opens settings (lazy-loaded) from the nav", async () => {
    mockFetch({
      "GET /api/status": () => json(status()),
      "GET /api/meetings": () => json({ items: [], nextCursor: null }),
      "GET /api/settings": () => json(DEFAULT_SETTINGS),
      "GET /api/jobs": () => json({ transcriptUnavailable: null, summaryUnavailable: null, languages: [], whisperLanguages: ["hi", "en"], engines: { whisper: null, qwen: null } }),
    });
    render(<App />);
    await screen.findByText("No recordings yet");
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByLabelText("Record meetings automatically")).not.toBeChecked()); // automatic recording is off by default (ask mode);
  });
});
