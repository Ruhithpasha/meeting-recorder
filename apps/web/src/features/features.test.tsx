import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { DEFAULT_SETTINGS } from "@meeting-recorder/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialMeetings, type MeetingsState } from "../hooks/meetingsReducer.ts";
import { json, meeting, mockFetch, status } from "../test/fixtures.ts";
import { MeetingList } from "./meetings/MeetingList.tsx";
import { MeetingPlayer } from "./meetings/MeetingPlayer.tsx";
import SettingsView from "./settings/SettingsView.tsx";
import { RecordingBanner } from "./status/RecordingBanner.tsx";

afterEach(() => vi.unstubAllGlobals());

const listProps = (state: Partial<MeetingsState>) => ({
  state: { ...initialMeetings, ...state },
  selectedId: null,
  onSelect: vi.fn(),
  onRetry: vi.fn(),
  onLoadMore: vi.fn(),
});

describe("MeetingList", () => {
  it("loading, error (with retry) and empty states", async () => {
    const { rerender } = render(<MeetingList {...listProps({ phase: "loading" })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading meetings");

    const props = listProps({ phase: "error", error: "Daemon unreachable" });
    rerender(<MeetingList {...props} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Daemon unreachable");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(props.onRetry).toHaveBeenCalled();

    rerender(<MeetingList {...listProps({ phase: "ready", items: [] })} />);
    expect(screen.getByText("No recordings yet")).toBeInTheDocument();
  });

  it("lists meetings with badges, selects one, and loads older pages", async () => {
    const props = listProps({
      phase: "ready",
      items: [meeting(3, { status: "recording" }), meeting(2, { status: "recovered" }), meeting(1)],
      nextCursor: meeting(1).id,
    });
    render(<MeetingList {...props} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("Recording")).toBeInTheDocument();
    expect(screen.getByText("Recovered")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Meeting 2"));
    expect(props.onSelect).toHaveBeenCalledWith(meeting(2).id);
    await userEvent.click(screen.getByRole("button", { name: "Load older meetings" }));
    expect(props.onLoadMore).toHaveBeenCalled();
  });

  it("no 'load more' on the last page; disabled while loading more", () => {
    const { rerender } = render(<MeetingList {...listProps({ phase: "ready", items: [meeting(1)], nextCursor: null })} />);
    expect(screen.queryByRole("button", { name: /older/ })).toBeNull();
    rerender(<MeetingList {...listProps({ phase: "ready", items: [meeting(1)], nextCursor: "x", loadingMore: true })} />);
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
  });
});

describe("MeetingPlayer", () => {
  it("asks to select a meeting when none is selected", () => {
    render(<MeetingPlayer meeting={null} onDeleted={vi.fn()} />);
    expect(screen.getByText("Select a meeting")).toBeInTheDocument();
  });

  it("plays from the media endpoint (Range-capable) and shows details", () => {
    const { container } = render(<MeetingPlayer meeting={meeting(1)} onDeleted={vi.fn()} />);
    expect(container.querySelector("video")).toHaveAttribute("src", `/api/meetings/${meeting(1).id}/media`);
    expect(screen.getByText(/30:00 · 300 MB/)).toBeInTheDocument();
  });

  it("no player and no delete while recording", () => {
    render(<MeetingPlayer meeting={meeting(1, { status: "recording" })} onDeleted={vi.fn()} />);
    expect(screen.getByText(/Recording in progress/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete…" })).toBeDisabled();
  });

  it("explains recovered recordings", () => {
    render(<MeetingPlayer meeting={meeting(1, { status: "recovered" })} onDeleted={vi.fn()} />);
    expect(screen.getByText(/interrupted and recovered/)).toBeInTheDocument();
  });

  it("delete needs a confirmation; cancel keeps it", async () => {
    const calls = mockFetch({});
    render(<MeetingPlayer meeting={meeting(1)} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls).toHaveLength(0);
  });

  it("confirmed delete calls the API and reports back", async () => {
    mockFetch({ [`DELETE /api/meetings/${meeting(1).id}`]: () => new Response(null, { status: 204 }) });
    const onDeleted = vi.fn();
    render(<MeetingPlayer meeting={meeting(1)} onDeleted={onDeleted} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    await userEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(meeting(1).id));
  });

  it("shows the server's message when delete fails (409 while recording)", async () => {
    mockFetch({ [`DELETE /api/meetings/${meeting(1).id}`]: () => json({ error: "Stop the recording before deleting it." }, { status: 409 }) });
    const onDeleted = vi.fn();
    render(<MeetingPlayer meeting={meeting(1)} onDeleted={onDeleted} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    await userEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Stop the recording before deleting it.");
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe("RecordingBanner", () => {
  it("connecting, idle (start), recording (stop) and warnings", async () => {
    const calls = mockFetch({
      "POST /api/meetings": () => json(status({ state: "starting" }), { status: 202 }),
      [`POST /api/meetings/${meeting(1).id}/stop`]: () => json(status({ state: "stopping" }), { status: 202 }),
    });
    const { rerender } = render(<RecordingBanner status={null} />);
    expect(screen.getByText(/Connecting/)).toBeInTheDocument();

    rerender(<RecordingBanner status={status()} />);
    await userEvent.click(screen.getByRole("button", { name: "Start recording" }));
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/api/meetings" });

    rerender(<RecordingBanner status={status({ state: "recording", meetingId: meeting(1).id })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Recording");
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(calls.at(-1)?.path).toBe(`/api/meetings/${meeting(1).id}/stop`);

    rerender(<RecordingBanner status={status({ warning: "Screen Recording permission is off." })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Screen Recording permission is off.");
  });

  it("can't start when the menu-bar app isn't connected", () => {
    render(<RecordingBanner status={status({ agentConnected: false })} />);
    expect(screen.getByText(/not connected/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start recording" })).toBeDisabled();
  });

  it("shows an API error (e.g. 409 already recording)", async () => {
    mockFetch({ "POST /api/meetings": () => json({ error: "Already recording." }, { status: 409 }) });
    render(<RecordingBanner status={status()} />);
    await userEvent.click(screen.getByRole("button", { name: "Start recording" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Already recording.");
  });
});

describe("SettingsView", () => {
  it("loads, edits and saves settings", async () => {
    const calls = mockFetch({
      "GET /api/settings": () => json(DEFAULT_SETTINGS),
      "PUT /api/settings": (init) => json(JSON.parse(String(init?.body))),
    });
    render(<SettingsView />);
    await userEvent.click(await screen.findByLabelText("Record meetings automatically"));
    await userEvent.selectOptions(screen.getByLabelText("Video quality"), "720p10");
    await userEvent.type(screen.getByLabelText(/Other apps/), "com.hnc.Discord");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ ...DEFAULT_SETTINGS, autoRecord: false, quality: "720p10", extraApps: ["com.hnc.Discord"] });
  });

  it("rejects invalid bundle ids without calling the API", async () => {
    const calls = mockFetch({ "GET /api/settings": () => json(DEFAULT_SETTINGS) });
    render(<SettingsView />);
    await userEvent.type(await screen.findByLabelText(/Other apps/), "rm -rf /");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("isn't a valid app bundle id");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("shows a load error with retry", async () => {
    let fail = true;
    mockFetch({ "GET /api/settings": () => (fail ? json({ error: "Daemon unreachable" }, { status: 500 }) : json(DEFAULT_SETTINGS)) });
    render(<SettingsView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Daemon unreachable");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Record meetings automatically")).toBeInTheDocument();
  });

  it("disables the model picker when transcription is off", async () => {
    mockFetch({ "GET /api/settings": () => json({ ...DEFAULT_SETTINGS, transcription: { enabled: false, model: "base" } }) });
    render(<SettingsView />);
    expect(await screen.findByLabelText("Model")).toBeDisabled();
  });
});
