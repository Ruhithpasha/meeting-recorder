import { useEffect, useState, type FormEvent } from "react";
import type { JobsInfo, Settings } from "@meeting-recorder/shared";
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
export default function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [extraApps, setExtraApps] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobsInfo | null>(null);

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
  }, []);

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
          <CardDescription>Made on this Mac when it's idle and plugged in. Nothing is sent anywhere.</CardDescription>
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
            <Label htmlFor="language">Meeting language</Label>
            <NativeSelect id="language" className="w-full" value={settings.transcription.language} disabled={!settings.transcription.enabled}
              onChange={(e) => transcription({ language: e.target.value })}>
              <NativeSelectOption value="auto">Same as this Mac</NativeSelectOption>
              {languageOptions(jobs?.languages ?? [], settings.transcription.language).map((id) => (
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
