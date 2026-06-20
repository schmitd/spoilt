import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ArrowDown, ArrowUp, Copy, Plus, RotateCcw, Save, Trash2, X } from "lucide-preact";
import { Button } from "../../components/Button";
import { RedactionPreview } from "../../components/RedactionPreview";
import { Toast } from "../../components/Toast";
import { createRule, DEFAULT_SETTINGS, normalizeSettings, parseKeywordInput } from "../../core/settings";
import type { BlockingRule, Settings } from "../../core/types";
import { loadSettings, saveSettings } from "../../platform/storage";

interface DeletedRule {
  rule: BlockingRule;
  index: number;
}

export function App() {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [deleted, setDeleted] = useState<DeletedRule | null>(null);
  const resetDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    void loadSettings().then((settings) => {
      setSaved(settings);
      setDraft(settings);
    });
  }, []);

  const dirty = useMemo(() => saved && draft ? JSON.stringify(saved) !== JSON.stringify(draft) : false, [draft, saved]);

  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [dirty]);

  if (!draft) return <main class="settings-page" aria-busy="true"><div class="skeleton" /></main>;

  function patch(patchValue: Partial<Settings>) {
    setDraft((current) => current ? normalizeSettings({ ...current, ...patchValue }) : current);
  }

  function updateRule(index: number, patchValue: Partial<BlockingRule>) {
    setDraft((current) => {
      if (!current) return current;
      const rules = current.rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patchValue } : rule);
      return { ...current, rules };
    });
  }

  function moveRule(index: number, offset: -1 | 1) {
    setDraft((current) => {
      if (!current) return current;
      const destination = index + offset;
      if (destination < 0 || destination >= current.rules.length) return current;
      const rules = [...current.rules];
      const [rule] = rules.splice(index, 1);
      if (!rule) return current;
      rules.splice(destination, 0, rule);
      return { ...current, rules };
    });
  }

  function deleteRule(index: number) {
    const rule = draft!.rules[index];
    if (!rule) return;
    setDeleted({ rule, index });
    setDraft((current) => current ? { ...current, rules: current.rules.filter((_, ruleIndex) => ruleIndex !== index) } : current);
  }

  function undoDelete() {
    if (!deleted) return;
    setDraft((current) => {
      if (!current) return current;
      const rules = [...current.rules];
      rules.splice(deleted.index, 0, deleted.rule);
      return { ...current, rules };
    });
    setDeleted(null);
  }

  async function handleSave(event: Event) {
    event.preventDefault();
    setSaving(true);
    setMessage("Saving your boundaries...");
    try {
      const normalized = normalizeSettings(draft);
      await saveSettings(normalized);
      setSaved(normalized);
      setDraft(normalized);
      setMessage("Boundaries saved. Open tabs will use them on the next check.");
    } catch (error) {
      setMessage(`We could not save your boundaries. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main class="settings-page">
      <header class="settings-header">
        <div>
          <p class="brand">Spoilt</p>
          <h1>Choose what reaches you</h1>
          <p>Set clear boundaries once. Spoilt applies them locally as you browse.</p>
        </div>
        <div class={`save-state ${dirty ? "is-dirty" : ""}`} role="status">
          {dirty ? "Unsaved changes" : "Everything is saved"}
        </div>
      </header>

      <form class="settings-form" onSubmit={handleSave}>
        <section class="settings-section" aria-labelledby="protection-title">
          <div class="section-heading">
            <div><span>1</span><div><h2 id="protection-title">Protection</h2><p>Choose what Spoilt checks and how cautious it should be.</p></div></div>
          </div>
          <div class="control-list">
            <Toggle checked={draft.enabled} onChange={(enabled) => patch({ enabled })} label="Enable protection" detail="Apply your boundaries while you browse." />
            <Toggle checked={draft.scanText} onChange={(scanText) => patch({ scanText })} label="Check visible text" detail="Conceal matching headlines, posts, comments, and article text." />
            <Toggle checked={draft.scanImages} onChange={(scanImages) => patch({ scanImages })} label="Check images" detail="Conceal images when their descriptions or on-device analysis match." />
          </div>
          <label class="field">
            <span>How cautious should Spoilt be?</span>
            <select value={draft.strictness} onChange={(event) => patch({ strictness: event.currentTarget.value as Settings["strictness"] })}>
              <option value="loose">Broad: conceal likely matches and indirect hints</option>
              <option value="balanced">Balanced: conceal clear matches</option>
              <option value="strict">Precise: conceal only specific matches</option>
            </select>
          </label>
        </section>

        <section class="settings-section" aria-labelledby="appearance-title">
          <div class="section-heading">
            <div><span>2</span><div><h2 id="appearance-title">Concealment style</h2><p>Choose the material Spoilt uses in place of blocked content.</p></div></div>
          </div>
          <fieldset class="segmented">
            <legend>Redaction appearance</legend>
            <label><input type="radio" name="redaction" checked={draft.redactionStyle === "marker"} onChange={() => patch({ redactionStyle: "marker" })} /><span>Marker</span></label>
            <label><input type="radio" name="redaction" checked={draft.redactionStyle === "whiteout"} onChange={() => patch({ redactionStyle: "whiteout" })} /><span>Whiteout tape</span></label>
          </fieldset>
          <RedactionPreview style={draft.redactionStyle} />
        </section>

        <section class="settings-section" aria-labelledby="analysis-title">
          <div class="section-heading">
            <div><span>3</span><div><h2 id="analysis-title">On-device analysis</h2><p>Improve matching without sending page content to a server.</p></div></div>
          </div>
          <div class="control-list">
            <Toggle checked={draft.useLocalAI} onChange={(useLocalAI) => patch({ useLocalAI, useVision: useLocalAI ? draft.useVision : false })} label="Use on-device analysis" detail="Chrome can compare meaning, not only exact keywords." />
            {draft.useLocalAI && <Toggle checked={draft.useVision} onChange={(useVision) => patch({ useVision })} label="Analyze images on this device" detail="When supported, Chrome examines image pixels locally." />}
          </div>
        </section>

        <section class="settings-section" aria-labelledby="memory-title">
          <div class="section-heading">
            <div><span>4</span><div><h2 id="memory-title">Recent spoiler knowledge</h2><p>Periodically collect public headlines related to your rules.</p></div></div>
          </div>
          <Toggle checked={draft.memoryEnabled} onChange={(memoryEnabled) => patch({ memoryEnabled })} label="Keep recent knowledge up to date" detail="Spoilt reads public search results for your subjects. Page content is never uploaded." />
          {draft.memoryEnabled && (
            <details class="advanced">
              <summary>Advanced refresh limits</summary>
              <div class="field-grid">
                <NumberField label="Refresh every" suffix="hours" value={draft.memoryRefreshHours} min={1} max={168} onChange={(memoryRefreshHours) => patch({ memoryRefreshHours })} />
                <NumberField label="Text references per rule" value={draft.memoryMaxEntriesPerRule} min={4} max={80} onChange={(memoryMaxEntriesPerRule) => patch({ memoryMaxEntriesPerRule })} />
                <NumberField label="Image references per rule" value={draft.memoryMaxImageExamplesPerRule} min={2} max={40} onChange={(memoryMaxImageExamplesPerRule) => patch({ memoryMaxImageExamplesPerRule })} />
              </div>
            </details>
          )}
        </section>

        <section class="settings-section settings-section--rules" aria-labelledby="rules-title">
          <div class="section-heading section-heading--actions">
            <div><span>5</span><div><h2 id="rules-title">Your boundaries</h2><p>Name what you want to avoid and give Spoilt examples.</p></div></div>
            <Button icon={<Plus size={18} />} onClick={() => setDraft((current) => current ? { ...current, rules: [...current.rules, createRule(current.rules.length)] } : current)}>Add boundary</Button>
          </div>
          <div class="rules-list">
            {draft.rules.length === 0 && <div class="empty-state"><h3>No boundaries yet</h3><p>Add one to start concealing unwanted content.</p></div>}
            {draft.rules.map((rule, index) => (
              <article class="rule-editor" key={rule.id}>
                <div class="rule-editor__header">
                  <label class="rule-enabled"><input type="checkbox" checked={rule.enabled} onChange={(event) => updateRule(index, { enabled: event.currentTarget.checked })} /><span>{rule.name || `Boundary ${index + 1}`}</span></label>
                  <div class="rule-tools" aria-label={`Actions for ${rule.name || `boundary ${index + 1}`}`}>
                    <button type="button" class="icon-button" aria-label="Move boundary up" disabled={index === 0} onClick={() => moveRule(index, -1)}><ArrowUp size={18} /></button>
                    <button type="button" class="icon-button" aria-label="Move boundary down" disabled={index === draft.rules.length - 1} onClick={() => moveRule(index, 1)}><ArrowDown size={18} /></button>
                    <button type="button" class="icon-button" aria-label="Duplicate boundary" onClick={() => setDraft((current) => current ? { ...current, rules: [...current.rules.slice(0, index + 1), { ...rule, id: crypto.randomUUID(), name: `${rule.name} copy` }, ...current.rules.slice(index + 1)] } : current)}><Copy size={18} /></button>
                    <button type="button" class="icon-button icon-button--danger" aria-label="Delete boundary" onClick={() => deleteRule(index)}><Trash2 size={18} /></button>
                  </div>
                </div>
                <div class="rule-fields">
                  <label class="field"><span>Name</span><input value={rule.name} onInput={(event) => updateRule(index, { name: event.currentTarget.value })} placeholder="Formula 1 results" /></label>
                  <label class="field field--wide"><span>What should be concealed?</span><textarea rows={3} value={rule.description} onInput={(event) => updateRule(index, { description: event.currentTarget.value })} placeholder="Winners, podiums, qualifying results, and championship standings. Do not conceal driver interviews without results." /></label>
                  <KeywordInput keywords={rule.keywords} onChange={(keywords) => updateRule(index, { keywords })} />
                </div>
              </article>
            ))}
          </div>
        </section>

        <footer class="form-actions">
          <Button tone="primary" icon={<Save size={18} />} loading={saving} type="submit" disabled={!dirty}>Save boundaries</Button>
          <Button tone="quiet" icon={<RotateCcw size={18} />} type="button" onClick={() => resetDialog.current?.showModal()}>Restore defaults</Button>
          <p role="status">{message}</p>
        </footer>
      </form>

      <dialog ref={resetDialog} class="confirm-dialog">
        <form method="dialog">
          <h2>Restore the original boundaries?</h2>
          <p>This replaces your current unsaved form with Spoilt's defaults. You can still leave without saving.</p>
          <div>
            <Button tone="quiet" type="submit" value="cancel">Keep editing</Button>
            <Button tone="danger" type="submit" value="default" onClick={() => { setDraft(DEFAULT_SETTINGS); setMessage("Defaults loaded. Save to apply them."); }}>Load defaults</Button>
          </div>
        </form>
      </dialog>

      {deleted && <Toast action={{ label: "Undo", onClick: undoDelete }} onDismiss={() => setDeleted(null)}>Boundary removed.</Toast>}
    </main>
  );
}

function Toggle({ checked, onChange, label, detail }: { checked: boolean; onChange: (checked: boolean) => void; label: string; detail: string }) {
  return (
    <label class="toggle-row">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span class="toggle-row__control" aria-hidden="true" />
      <span><strong>{label}</strong><small>{detail}</small></span>
    </label>
  );
}

function NumberField({ label, suffix, value, min, max, onChange }: { label: string; suffix?: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <label class="field"><span>{label}</span><div class="number-input"><input type="number" value={value} min={min} max={max} onInput={(event) => onChange(Number(event.currentTarget.value))} />{suffix && <span>{suffix}</span>}</div></label>;
}

function KeywordInput({ keywords, onChange }: { keywords: string[]; onChange: (keywords: string[]) => void }) {
  const [value, setValue] = useState("");
  const labelId = useMemo(() => `keywords-${crypto.randomUUID()}`, []);
  const helpId = `${labelId}-help`;

  function commit(rawValue = value) {
    const additions = parseKeywordInput(rawValue);
    if (additions.length) {
      const seen = new Set(keywords.map((keyword) => keyword.toLocaleLowerCase()));
      onChange([
        ...keywords,
        ...additions.filter((keyword) => {
          const normalized = keyword.toLocaleLowerCase();
          if (seen.has(normalized)) return false;
          seen.add(normalized);
          return true;
        }),
      ]);
    }
    setValue("");
  }

  return (
    <div class="field field--wide">
      <span id={labelId}>Immediate keywords</span>
      <div class="keyword-entry" onClick={(event) => event.currentTarget.querySelector("input")?.focus()}>
        {keywords.map((keyword) => (
          <span class="keyword-chip" key={keyword}>
            {keyword}
            <button type="button" aria-label={`Remove keyword ${keyword}`} onClick={() => onChange(keywords.filter((item) => item !== keyword))}>
              <X size={14} />
            </button>
          </span>
        ))}
        <input
          aria-labelledby={labelId}
          aria-describedby={helpId}
          value={value}
          onInput={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "," || event.key === ";" || event.key === " ") {
              event.preventDefault();
              commit();
            } else if (event.key === "Backspace" && !value && keywords.length) {
              onChange(keywords.slice(0, -1));
            }
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData?.getData("text") ?? "";
            if (/[\s,;]/.test(pasted)) {
              event.preventDefault();
              commit(pasted);
            }
          }}
          onBlur={() => commit()}
          placeholder={keywords.length ? "Add another" : "Type a keyword"}
        />
      </div>
      <small id={helpId}>Press Space, Enter, or comma after each keyword. These work without on-device analysis.</small>
    </div>
  );
}
