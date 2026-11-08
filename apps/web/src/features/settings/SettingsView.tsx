import { useEffect, useState, type FormEvent } from "react";
import type { JobsInfo, ModelEngine, ModelState, Settings } from "@meeting-recorder/shared";
import { Check, Info } from "lucide-react";
import { api } from "@/api/client.ts";
import { ErrorState, Spinner } from "@/components/ui.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ModelDownload } from "./ModelDownload.tsx";

const BUNDLE_ID = /^[A-Za-z0-9.-]+\*?$/;

/** "hi_IN" -> "Hindi (India)", in the viewer's language. */
function languageName(id: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: "language" }).of(id.replace("_", "-")) ?? id;
  } catch {
    return id;
  }
}

/** The supported languages, plus the saved one if the list lacks it, so the picker always shows the real setting. */
function languageOptions(supported: string[], saved: string): string[] {
  return saved === "auto" || supported.includes(saved) ? supported : [saved, ...supported];
}

/** Lazy-loaded (code split): most visits never open settings. */
export default function SettingsView({ liveModels }: { liveModels?: Partial<Record<ModelEngine, ModelState>> }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [extraApps, setExtraApps] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobsInfo | null>(null);
  const [models, setModels] = useState<Partial<Record<ModelEngine, ModelState>>>({});
  const [cancelling, setCancelling] = useState<Partial<Record<ModelEngine, { busy?: boolean; error?: string }>>>({});

  const load = async () => {
    setLoadError(null);
    try {
      const s = await api.getSettings();
      setSettings(s);
      setExtraApps(s.extraApps.join("\n"));
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    api.jobs().then(setJobs, () => setJobs(null));
    api.models().then((fetched) => setModels((m) => ({ ...fetched, ...m })), () => {}); // live news that came first wins
  }, []);

  // Each live event (download progress) is merged in as it arrives; a later local result (for
  // example a refused download) then replaces it, so the newest news is always what's shown.
  useEffect(() => { if (liveModels) setModels((m) => ({ ...m, ...liveModels })); }, [liveModels]);
  const modelState = (engine: ModelEngine) => models[engine];
  const download = (engine: ModelEngine) => {
    setModels((m) => ({ ...m, [engine]: { state: "downloading", percent: 0 } }));
    api.downloadModel(engine).then(
      (state) => setModels((m) => ({ ...m, [engine]: state })),
      (e: Error) => setModels((m) => ({ ...m, [engine]: { state: "failed", error: e.message } })),
    );
  };

  // Cancel shows its result at once (the server says what the cancel leads to); a failed request
  // leaves the download running and says so, rather than inventing a failure.
  const cancelDownload = (engine: ModelEngine) => {
    setCancelling((c) => ({ ...c, [engine]: { busy: true } }));
    api.cancelModelDownload(engine).then(
      (state) => { setModels((m) => ({ ...m, [engine]: state })); setCancelling((c) => ({ ...c, [engine]: {} })); },
      (e: Error) => setCancelling((c) => ({ ...c, [engine]: { error: e.message } })),
    );
  };

  if (loadError) return <ErrorState message={loadError} onRetry={load} />;
  if (!settings) return <Spinner label="Loading settings" />;

  const update = (patch: Partial<Settings>) => {
    setSettings({ ...settings, ...patch });
    setSaveState("idle");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const apps = extraApps.split("\n").map((s) => s.trim()).filter(Boolean);
    const invalid = apps.find((a) => !BUNDLE_ID.test(a));
    if (invalid) { setError(`"${invalid}" isn't a valid app bundle id (e.g. com.hnc.Discord).`); return; }
    setError(null);
    setSaveState("saving");
    try {
      const saved = await api.putSettings({ ...settings, extraApps: apps });
      setSettings(saved);
      setExtraApps(saved.extraApps.join("\n"));
      setSaveState("saved");
    } catch (e) {
      setError((e as Error).message);
      setSaveState("idle");
    }
  };

  const transcription = (patch: Partial<Settings["transcription"]>) =>
    update({ transcription: { ...settings.transcription, ...patch } });

  return (
    <form className="grid max-w-2xl gap-5 animate-in fade-in duration-300" onSubmit={submit} aria-label="Settings">
      <Card>
        <CardHeader><CardTitle className="font-heading text-base">Recording</CardTitle></CardHeader>
        <CardContent className="grid gap-5">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="auto-record">Record meetings automatically</Label>
            <Switch id="auto-record" checked={settings.autoRecord} onCheckedChange={(on) => update({ autoRecord: on })} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="quality">Video quality</Label>
            <NativeSelect id="quality" className="w-full" value={settings.quality}
              onChange={(e) => update({ quality: e.target.value as Settings["quality"] })}>
              <NativeSelectOption value="720p30">720p, 30 fps (recommended, ~1.1 GB/hour)</NativeSelectOption>
              <NativeSelectOption value="1080p30">1080p, 30 fps (sharpest, ~2.2 GB/hour)</NativeSelectOption>
              <NativeSelectOption value="720p15">720p, 15 fps (lighter, ~0.7 GB/hour)</NativeSelectOption>
              <NativeSelectOption value="1080p15">1080p, 15 fps (sharp text, ~1.4 GB/hour)</NativeSelectOption>
              <NativeSelectOption value="720p10">720p, 10 fps (lowest CPU and disk)</NativeSelectOption>
            </NativeSelect>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="extra-apps">Other apps that should start a recording (one bundle id per line)</Label>
            <Textarea id="extra-apps" rows={3} value={extraApps} placeholder="com.hnc.Discord" spellCheck={false}
              onChange={(e) => { setExtraApps(e.target.value); setSaveState("idle"); }} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="font-heading text-base">Transcripts and summaries</CardTitle>
          <CardDescription>Made on this Mac, live during the meeting where possible. Nothing is sent anywhere.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="transcribe">Transcribe recordings</Label>
            <Switch id="transcribe" checked={settings.transcription.enabled} onCheckedChange={(on) => transcription({ enabled: on })} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="summarize">Write a summary after transcribing (key points, decisions, action items)</Label>
            <Switch id="summarize" checked={settings.transcription.summarize} disabled={!settings.transcription.enabled}
              onCheckedChange={(on) => transcription({ summarize: on })} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="engine">Transcription engine</Label>
            <NativeSelect id="engine" className="w-full" value={settings.transcription.engine} disabled={!settings.transcription.enabled}
              onChange={(e) => transcription({ engine: e.target.value as Settings["transcription"]["engine"] })}>
              <NativeSelectOption value="apple">Apple (built in, no download)</NativeSelectOption>
              <NativeSelectOption value="whisper" disabled={!!jobs?.engines.whisper}>Whisper large-v3 turbo (more accurate, 632 MB download)</NativeSelectOption>
            </NativeSelect>
            {jobs?.engines.whisper && <p className="text-xs text-muted-foreground">{jobs.engines.whisper}</p>}
            {settings.transcription.engine === "whisper" && <ModelDownload engine="whisper" state={modelState("whisper")} onDownload={() => download("whisper")} onCancel={() => cancelDownload("whisper")}
                cancelling={cancelling.whisper?.busy} cancelError={cancelling.whisper?.error} />}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="summary-engine">Summary engine</Label>
            <NativeSelect id="summary-engine" className="w-full" value={settings.transcription.summaryEngine}
              disabled={!settings.transcription.enabled || !settings.transcription.summarize}
              onChange={(e) => transcription({ summaryEngine: e.target.value as Settings["transcription"]["summaryEngine"] })}>
              <NativeSelectOption value="apple">Apple Intelligence (built in, no download)</NativeSelectOption>
              <NativeSelectOption value="qwen" disabled={!!jobs?.engines.qwen}>Qwen3 1.7B open model (1.8 GB download)</NativeSelectOption>
            </NativeSelect>
            {jobs?.engines.qwen && <p className="text-xs text-muted-foreground">{jobs.engines.qwen}</p>}
            {settings.transcription.summaryEngine === "qwen" && <ModelDownload engine="qwen" state={modelState("qwen")} onDownload={() => download("qwen")} onCancel={() => cancelDownload("qwen")}
                cancelling={cancelling.qwen?.busy} cancelError={cancelling.qwen?.error} />}
            <p className="text-xs text-muted-foreground">
              Open models download once from Hugging Face, then run only on this Mac, at low priority, when you're not recording.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="language">Meeting language</Label>
            <NativeSelect id="language" className="w-full" value={settings.transcription.language} disabled={!settings.transcription.enabled}
              onChange={(e) => transcription({ language: e.target.value })}>
              <NativeSelectOption value="auto">{settings.transcription.engine === "whisper" ? "Detect automatically" : "Same as this Mac"}</NativeSelectOption>
              {languageOptions((settings.transcription.engine === "whisper" ? jobs?.whisperLanguages : jobs?.languages) ?? [],
                settings.transcription.language).map((id) => (
                <NativeSelectOption key={id} value={id}>{languageName(id)}</NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {(jobs?.transcriptUnavailable ?? jobs?.summaryUnavailable) && (
            <Alert className="border-0 bg-warn" role="note">
              <Info className="text-warn-foreground" />
              <AlertDescription className="text-warn-foreground">{jobs?.transcriptUnavailable ?? jobs?.summaryUnavailable}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saveState === "saving"}>{saveState === "saving" ? "Saving…" : "Save"}</Button>
        {saveState === "saved" && (
          <span role="status" className="inline-flex items-center gap-1 text-sm text-primary animate-in fade-in zoom-in-95"><Check className="size-4" />Saved</span>
        )}
      </div>
    </form>
  );
}
