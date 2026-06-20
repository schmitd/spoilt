import { useEffect, useMemo, useState } from "preact/hooks";
import { BookOpen, Brain, ExternalLink, RefreshCw, ScanSearch, ShieldCheck, Sparkles } from "lucide-preact";
import { browser } from "wxt/browser";
import { Button } from "../../components/Button";
import { EMPTY_STATUS } from "../../core/status";
import type { ExtensionStatus, Settings } from "../../core/types";
import { refreshMemory, sendToActiveTab } from "../../platform/messages";
import { loadSettings, loadStatus, saveSettings } from "../../platform/storage";
import { prepareLocalAi } from "../../services/local-ai";

type BusyAction = "prepare" | "refresh" | "scan" | null;

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<ExtensionStatus>(EMPTY_STATUS);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void Promise.all([loadSettings(), loadStatus()]).then(([nextSettings, nextStatus]) => {
      setSettings(nextSettings);
      setStatus(nextStatus);
    });
  }, []);

  const masks = status.counters.text + status.counters.images;
  const protectionCopy = useMemo(() => {
    if (!settings?.enabled) return "Protection is paused";
    if (status.lastError) return "Protection needs attention";
    if (status.pendingText + status.pendingImages > 0) return "Checking this page";
    return masks > 0 ? `${masks} item${masks === 1 ? "" : "s"} concealed on this page` : "Protection is active";
  }, [masks, settings?.enabled, status.lastError, status.pendingImages, status.pendingText]);

  async function toggleEnabled() {
    if (!settings) return;
    const next = { ...settings, enabled: !settings.enabled };
    setSettings(next);
    await saveSettings(next);
    await run("scan", async () => {
      const response = await sendToActiveTab("scan");
      if (response.status) setStatus(response.status);
    });
  }

  async function run(action: Exclude<BusyAction, null>, operation: () => Promise<void>) {
    setBusy(action);
    setMessage("");
    try {
      await operation();
      setStatus(await loadStatus());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  if (!settings) return <main class="popup popup--loading" aria-busy="true"><div class="skeleton" /></main>;

  return (
    <main class="popup">
      <header class="popup__header">
        <div>
          <p class="brand">Spoilt</p>
          <h1>{protectionCopy}</h1>
        </div>
        <label class="switch">
          <input type="checkbox" checked={settings.enabled} onChange={() => void toggleEnabled()} />
          <span aria-hidden="true" />
          <span class="sr-only">{settings.enabled ? "Pause protection" : "Enable protection"}</span>
        </label>
      </header>

      <section class={`protection-state ${settings.enabled ? "is-active" : "is-paused"}`}>
        <ShieldCheck size={22} aria-hidden="true" />
        <div>
          <strong>{settings.enabled ? "Your boundaries are on" : "Your boundaries are paused"}</strong>
          <p>{settings.enabled ? "Spoilt checks visible text and images against your rules." : "This page will remain unchanged until protection is enabled."}</p>
        </div>
      </section>

      {message && <p class="notice notice--error" role="alert">{message}</p>}
      {status.lastError && <p class="notice notice--error" role="alert">{status.lastError}</p>}

      <div class="quick-stats" aria-label="Current page activity">
        <div><strong>{status.counters.text}</strong><span>Text concealed</span></div>
        <div><strong>{status.counters.images}</strong><span>Images concealed</span></div>
      </div>

      <div class="primary-actions">
        <Button tone="primary" icon={<ScanSearch size={18} />} loading={busy === "scan"} onClick={() => void run("scan", async () => {
          const response = await sendToActiveTab("scan");
          if (!response.ok) throw new Error(response.error);
          if (response.status) setStatus(response.status);
        })}>Check this page</Button>
        <Button icon={<RefreshCw size={18} />} loading={busy === "refresh"} onClick={() => void run("refresh", async () => {
          const memory = await refreshMemory();
          setStatus((current) => ({ ...current, memory }));
        })}>Update recent knowledge</Button>
      </div>

      <details class="diagnostics">
        <summary>Protection details</summary>
        <dl>
          <div><dt><Brain size={15} /> Text analysis</dt><dd>{friendlyModelState(status.aiText)}</dd></div>
          <div><dt><Sparkles size={15} /> Image analysis</dt><dd>{friendlyModelState(status.aiVision)}</dd></div>
          <div><dt><BookOpen size={15} /> Recent knowledge</dt><dd>{status.memory.entryCount + status.memory.imageExampleCount} references</dd></div>
        </dl>
        {status.aiReason && <p>{status.aiReason}</p>}
        <Button tone="quiet" icon={<Brain size={17} />} loading={busy === "prepare"} onClick={() => void run("prepare", async () => {
          await sendToActiveTab("resetAI");
          await prepareLocalAi(settings);
        })}>Prepare on-device analysis</Button>
      </details>

      <footer class="popup__footer">
        <Button tone="quiet" icon={<ExternalLink size={17} />} onClick={() => browser.runtime.openOptionsPage()}>Manage boundaries</Button>
      </footer>
    </main>
  );
}

function friendlyModelState(state: ExtensionStatus["aiText"]): string {
  if (state === "available") return "Ready on this device";
  if (state === "downloading" || state === "checking" || state === "recovering") return "Preparing";
  if (state === "fallback" || state === "metadata fallback") return "Using rule details";
  if (state === "unavailable") return "Keywords only";
  return "Not checked yet";
}
