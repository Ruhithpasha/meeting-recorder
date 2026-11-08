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
    expect(screen.getByText("30:00")).toBeInTheDocument();
    expect(screen.getByText("300 MB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show in Finder" })).toBeInTheDocument();
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
    expect(screen.getByText(/isn't connected/)).toBeInTheDocument();
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
      "GET /api/jobs": () => json({ transcriptUnavailable: null, summaryUnavailable: null, languages: ["en_IN", "hi_IN"], whisperLanguages: ["hi", "en"], engines: { whisper: null, qwen: null } }),
      "PUT /api/settings": (init) => json(JSON.parse(String(init?.body))),
    });
    render(<SettingsView />);
    await userEvent.click(await screen.findByLabelText("Record meetings automatically"));
    await screen.findByRole("option", { name: /Hindi/ });
    await userEvent.selectOptions(screen.getByLabelText("Meeting language"), "hi_IN");
    await userEvent.selectOptions(screen.getByLabelText("Video quality"), "720p10");
    await userEvent.type(screen.getByLabelText(/Other apps/), "com.hnc.Discord");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ ...DEFAULT_SETTINGS, autoRecord: false, quality: "720p10", extraApps: ["com.hnc.Discord"],
      transcription: { ...DEFAULT_SETTINGS.transcription, language: "hi_IN" } });
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

  it("the summary switch is disabled when transcription is off, and saves", async () => {
    const calls = mockFetch({
      "GET /api/settings": () => json({ ...DEFAULT_SETTINGS, transcription: { enabled: false, summarize: true, language: "auto", engine: "apple", summaryEngine: "apple" } }),
      "GET /api/jobs": () => json({ transcriptUnavailable: null, summaryUnavailable: "Summaries need Apple Intelligence turned on.", languages: [], whisperLanguages: ["hi", "en"], engines: { whisper: null, qwen: null } }),
      "PUT /api/settings": (init) => json(JSON.parse(String(init?.body))),
    });
    render(<SettingsView />);
    const summarize = await screen.findByLabelText(/Write a summary/);
    expect(summarize).toBeDisabled();
    await userEvent.click(screen.getByLabelText("Transcribe recordings"));
    await userEvent.click(summarize);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved");
    expect(JSON.parse(calls.at(-1)!.body!).transcription).toEqual({ enabled: true, summarize: false, language: "auto", engine: "apple", summaryEngine: "apple" });
  });
});

describe("TranscriptPanel (via MeetingPlayer)", () => {
  const transcript = {
    version: 1, language: "en_US", durationSec: 20,
    segments: [
      { start: 1.2, end: 3, speaker: "Others", text: "Morning everyone." },
      { start: 4, end: 6, speaker: "You", text: "Let's start." },
    ],
  };

  it("shows the transcript with speakers; clicking a line seeks the video", async () => {
    mockFetch({ [`GET /api/meetings/${meeting(1).id}/transcript`]: () => json(transcript) });
    const { container } = render(<MeetingPlayer meeting={meeting(1, { transcript: "done" })} onDeleted={vi.fn()} />);
    expect(await screen.findByText("Morning everyone.")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    const video = container.querySelector("video")!;
    video.play = vi.fn(() => Promise.resolve());
    await userEvent.click(screen.getByText("Let's start."));
    expect(video.currentTime).toBe(4);
  });

  it("explains waiting, running and failed (with Retry)", async () => {
    const calls = mockFetch({ [`POST /api/meetings/${meeting(1).id}/transcribe`]: () => json(meeting(1, { transcript: "queued" }), { status: 202 }) });
    const { rerender } = render(<MeetingPlayer meeting={meeting(1, { transcript: "none" })} onDeleted={vi.fn()} />);
    expect(screen.getByText(/idle and plugged in/)).toBeInTheDocument();
    rerender(<MeetingPlayer meeting={meeting(1, { transcript: "running" })} onDeleted={vi.fn()} />);
    expect(screen.getByText(/Transcribing on this Mac/)).toBeInTheDocument();
    rerender(<MeetingPlayer meeting={meeting(1, { transcript: "failed" })} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: `/api/meetings/${meeting(1).id}/transcribe` });
  });

  it("shows the server's reason when transcription is unavailable", async () => {
    mockFetch({ [`POST /api/meetings/${meeting(1).id}/transcribe`]: () => json({ error: "Transcription needs macOS 26 or later." }, { status: 409 }) });
    render(<MeetingPlayer meeting={meeting(1)} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Transcribe now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("macOS 26");
  });

  it("no transcript section while recording; empty transcripts say so", async () => {
    mockFetch({ [`GET /api/meetings/${meeting(1).id}/transcript`]: () => json({ ...transcript, segments: [] }) });
    const { rerender } = render(<MeetingPlayer meeting={meeting(1, { status: "recording" })} onDeleted={vi.fn()} />);
    expect(screen.queryByText("Transcript")).toBeNull();
    rerender(<MeetingPlayer meeting={meeting(1, { transcript: "done" })} onDeleted={vi.fn()} />);
    expect(await screen.findByText(/No speech was found/)).toBeInTheDocument();
  });
});

describe("dashboard improvements", () => {
  it("groups meetings by day and filters with search", async () => {
    const today = new Date(); today.setHours(9, 0, 0, 0);
    const props = listProps({
      phase: "ready",
      items: [
        meeting(9, { title: "Design review", startedAt: today.toISOString() }),
        meeting(1, { title: "Budget sync", app: "Microsoft Teams" }),
      ],
    });
    render(<MeetingList {...props} />);
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Search meetings"), "teams");
    expect(screen.queryByText("Design review")).toBeNull();
    expect(screen.getByText("Budget sync")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Search meetings"));
    await userEvent.type(screen.getByLabelText("Search meetings"), "zzz");
    expect(screen.getByText(/No meetings match/)).toBeInTheDocument();
  });

  it("the banner shows the live meeting's app and a running timer", () => {
    const started = new Date(Date.now() - 125_000).toISOString();
    render(<RecordingBanner status={status({ state: "recording", meetingId: meeting(1).id })} meeting={meeting(1, { app: "Google Meet", startedAt: started, status: "recording" })} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Recording: Google Meet/);
    expect(screen.getByRole("status")).toHaveTextContent(/2:0\d/);
  });

  it("Show in Finder asks the daemon to reveal the file", async () => {
    const calls = mockFetch({ [`POST /api/meetings/${meeting(1).id}/reveal`]: () => new Response(null, { status: 204 }) });
    render(<MeetingPlayer meeting={meeting(1)} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: `/api/meetings/${meeting(1).id}/reveal` });
  });
});

describe("review fixes", () => {
  it("search explains it only covers loaded meetings when there are more pages", async () => {
    render(<MeetingList {...listProps({ phase: "ready", items: [meeting(1)], nextCursor: "x" })} />);
    await userEvent.type(screen.getByLabelText("Search meetings"), "budget");
    expect(screen.getByText(/load older meetings to search further/)).toBeInTheDocument();
  });
});

describe("SummaryPanel (via MeetingPlayer)", () => {
  const summary = { version: 1, overview: "Budget review.", keyPoints: ["Spend 12% over"], decisions: ["Use an agency"], actionItems: ["Priya: send JDs"] };

  it("shows overview and sections; Copy puts Markdown on the clipboard", async () => {
    mockFetch({
      [`GET /api/meetings/${meeting(1).id}/summary`]: () => json(summary),
      [`GET /api/meetings/${meeting(1).id}/summary.md`]: () => new Response("# Meeting 1\n\n## Decisions\n\n- Use an agency\n"),
      [`GET /api/meetings/${meeting(1).id}/transcript`]: () => json({ version: 1, language: "en", durationSec: 1, segments: [] }),
    });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<MeetingPlayer meeting={meeting(1, { transcript: "done", summary: "done" })} onDeleted={vi.fn()} />);
    expect(await screen.findByText("Budget review.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Action items" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("## Decisions\n\n- Use an agency"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("hidden until there's a transcript; then offers Summarize now, running and Retry", async () => {
    const calls = mockFetch({
      [`POST /api/meetings/${meeting(1).id}/summarize`]: () => json(meeting(1), { status: 202 }),
      [`GET /api/meetings/${meeting(1).id}/transcript`]: () => json({ version: 1, language: "en", durationSec: 1, segments: [] }),
    });
    const { rerender } = render(<MeetingPlayer meeting={meeting(1)} onDeleted={vi.fn()} />);
    expect(screen.queryByText("Summary")).toBeNull();
    rerender(<MeetingPlayer meeting={meeting(1, { transcript: "done" })} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Summarize now" }));
    expect(calls.some((c) => c.path === `/api/meetings/${meeting(1).id}/summarize`)).toBe(true);
    rerender(<MeetingPlayer meeting={meeting(1, { transcript: "done", summary: "running" })} onDeleted={vi.fn()} />);
    expect(screen.getByText(/Writing a summary on this Mac/)).toBeInTheDocument();
    rerender(<MeetingPlayer meeting={meeting(1, { transcript: "done", summary: "failed" })} onDeleted={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("shows why summaries are unavailable (e.g. Apple Intelligence off)", async () => {
    mockFetch({
      [`POST /api/meetings/${meeting(1).id}/summarize`]: () => json({ error: "Summaries need Apple Intelligence turned on." }, { status: 409 }),
      [`GET /api/meetings/${meeting(1).id}/transcript`]: () => json({ version: 1, language: "en", durationSec: 1, segments: [] }),
    });
    render(<MeetingPlayer meeting={meeting(1, { transcript: "done" })} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Summarize now" }));
    expect(await screen.findByText(/Apple Intelligence/)).toBeInTheDocument();
  });
});

describe("v0.4 dashboard", () => {
  it("shows the saved language even when the language list couldn't load", async () => {
    mockFetch({
      "GET /api/settings": () => json({ ...DEFAULT_SETTINGS, transcription: { ...DEFAULT_SETTINGS.transcription, language: "hi_IN" } }),
      "GET /api/jobs": () => json({ transcriptUnavailable: null, summaryUnavailable: null, languages: [], whisperLanguages: ["hi", "en"], engines: { whisper: null, qwen: null } }),
    });
    render(<SettingsView />);
    expect(await screen.findByLabelText("Meeting language")).toHaveValue("hi_IN");
  });

  it("explains unavailable summaries in settings", async () => {
    mockFetch({
      "GET /api/settings": () => json(DEFAULT_SETTINGS),
      "GET /api/jobs": () => json({ transcriptUnavailable: null, summaryUnavailable: "Summaries need Apple Intelligence turned on.", languages: [], whisperLanguages: ["hi", "en"], engines: { whisper: null, qwen: null } }),
    });
    render(<SettingsView />);
    expect(await screen.findByText(/Apple Intelligence turned on/)).toBeInTheDocument();
  });

  it("shows the saved reason when a summary failed", () => {
    render(<MeetingPlayer meeting={meeting(1, { transcript: "done", summary: "failed", summaryError: "Apple's on-device model declined to summarize this meeting." })} onDeleted={vi.fn()} />);
    expect(screen.getByText(/declined to summarize/)).toBeInTheDocument();
  });
});

describe("open models and sharing", () => {
  it("chooses open-model engines; an engine this Mac can't run is disabled with the reason", async () => {
    const calls = mockFetch({
      "GET /api/settings": () => json(DEFAULT_SETTINGS),
      "GET /api/jobs": () => json({ transcriptUnavailable: null, summaryUnavailable: null, languages: [], whisperLanguages: ["hi", "en"],
        engines: { whisper: null, qwen: "The open summary model needs at least 8 GB of memory." } }),
      "PUT /api/settings": (init) => json(JSON.parse(String(init?.body))),
    });
    render(<SettingsView />);
    await screen.findByText(/needs at least 8 GB/);
    expect(screen.getByRole("option", { name: /Qwen3/ })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Transcription engine"), "whisper");
    expect(screen.getByRole("option", { name: "Detect automatically" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Hindi" })).toBeInTheDocument(); // Whisper's own list, any macOS
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved");
    expect(JSON.parse(calls.at(-1)!.body!).transcription.engine).toBe("whisper");
  });

  it("shares a smaller video copy from the Share menu and shows its progress", async () => {
    const calls = mockFetch({
      [`POST /api/meetings/${meeting(1).id}/share`]: () => json({ state: "exporting" }, { status: 202 }),
    });
    const { rerender } = render(<MeetingPlayer meeting={meeting(1)} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Share/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Video/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toBe(JSON.stringify({ what: "video" })));
    rerender(<MeetingPlayer meeting={meeting(1)} share={{ type: "share", id: meeting(1).id, state: "exporting", percent: 42 }} onDeleted={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Making a smaller copy… 42%/ })).toBeDisabled();
    const failed = { type: "share", id: meeting(1).id, state: "failed", error: "Writing the copy failed." } as const;
    rerender(<MeetingPlayer meeting={meeting(1)} share={failed} onDeleted={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Writing the copy failed.");
    await userEvent.click(screen.getByRole("button", { name: /Share/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Original/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull()); // a new share hides the old failure
  });

  it("offers the summary in the Share menu only when there is one", async () => {
    render(<MeetingPlayer meeting={meeting(1, { transcript: "done", summary: "done" })} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Share/ }));
    expect(await screen.findByRole("menuitem", { name: "Summary" })).toBeInTheDocument();
  });
});
