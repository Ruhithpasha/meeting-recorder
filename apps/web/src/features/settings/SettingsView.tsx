import { useEffect, useState, type FormEvent } from "react";
import type { Settings } from "@meeting-recorder/shared";
import { api } from "../../api/client.ts";
import { Button, ErrorState, Spinner } from "../../components/ui.tsx";

const BUNDLE_ID = /^[A-Za-z0-9.-]+\*?$/;

/** Lazy-loaded (code split): most visits never open settings. */
export default function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [extraApps, setExtraApps] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

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
  useEffect(() => { void load(); }, []);

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

  return (
    <form className="settings" onSubmit={submit} aria-label="Settings">
      <label className="field-row">
        <input type="checkbox" checked={settings.autoRecord} onChange={(e) => update({ autoRecord: e.target.checked })} />
        Record meetings automatically
      </label>

      <label className="field">
        Video quality
        <select value={settings.quality} onChange={(e) => update({ quality: e.target.value as Settings["quality"] })}>
          <option value="720p15">720p, 15 fps (recommended, ~700 MB/hour)</option>
          <option value="1080p15">1080p, 15 fps (sharper text, larger files)</option>
          <option value="720p10">720p, 10 fps (lowest CPU and disk)</option>
        </select>
      </label>

      <fieldset className="field">
        <legend>Transcription (runs on this Mac, only when idle and plugged in)</legend>
        <label className="field-row">
          <input type="checkbox" checked={settings.transcription.enabled}
            onChange={(e) => update({ transcription: { ...settings.transcription, enabled: e.target.checked } })} />
          Transcribe recordings
        </label>
        <label className="field">
          Model
          <select value={settings.transcription.model} disabled={!settings.transcription.enabled}
            onChange={(e) => update({ transcription: { ...settings.transcription, model: e.target.value as Settings["transcription"]["model"] } })}>
            <option value="tiny">Tiny (fastest)</option>
            <option value="base">Base (recommended)</option>
            <option value="small">Small (most accurate, slower)</option>
          </select>
        </label>
      </fieldset>

      <label className="field">
        Other apps that should start a recording (one bundle id per line)
        <textarea rows={3} value={extraApps} placeholder="com.hnc.Discord" spellCheck={false}
          onChange={(e) => { setExtraApps(e.target.value); setSaveState("idle"); }} />
      </label>

      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="form-actions">
        <Button type="submit" variant="primary" disabled={saveState === "saving"}>
          {saveState === "saving" ? "Saving…" : "Save"}
        </Button>
        {saveState === "saved" && <span role="status">Saved</span>}
      </div>
    </form>
  );
}
