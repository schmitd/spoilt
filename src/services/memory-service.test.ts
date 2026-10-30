import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMemory } from "../core/memory";
import { ruleCriteriaKey } from "../core/rule-criteria";
import { DEFAULT_SETTINGS } from "../core/settings";
import { MEMORY_KEY } from "../core/status";
import type { BlockingRule, MemoryEntry, MemoryImageExample, MemoryRuleRun, Settings, SpoilerMemory } from "../core/types";
import { refreshSpoilerMemory } from "./memory-service";

const { localGet, localSet, loadSettings, updateStatus, fetchMock } = vi.hoisted(() => ({
  localGet: vi.fn(), localSet: vi.fn(), loadSettings: vi.fn(), updateStatus: vi.fn(), fetchMock: vi.fn(),
}));
vi.mock("wxt/browser", () => ({ browser: { storage: { local: { get: localGet, set: localSet } } } }));
vi.mock("../platform/storage", () => ({ loadSettings, updateStatus }));

const oldTime = "2026-10-28T12:00:00.000Z";
const rss = `<?xml version="1.0"?><rss><channel><item>
  <title>Current orbital event reveals winning crew</title>
  <link>https://example.test/current-orbit</link>
  <source>Synthetic News</source><pubDate>Fri, 30 Oct 2026 12:00:00 GMT</pubDate>
  <description>Public article data about the winning crew.</description>
  <media:thumbnail url="https://images.example.test/current-orbit.jpg" />
</item></channel></rss>`;

function rule(patch: Partial<BlockingRule> = {}): BlockingRule {
  return { id: "orbit", name: "DisplayAlpha", description: "Orbital uprising outcomes", keywords: ["stellar"], enabled: true, ...patch };
}
function entry(ruleId: string, id = `old-${ruleId}`): MemoryEntry {
  return { id, ruleId, title: `Preserved ${ruleId} public history`, snippet: "An earlier article's actual public data.",
    url: `https://example.test/${id}`, source: "Synthetic News", publishedAt: oldTime, discoveredAt: oldTime,
    terms: ["earlier", "public"], reason: "Earlier display-derived explanation" };
}
function image(ruleId: string): MemoryImageExample {
  return { id: `old-image-${ruleId}`, ruleId, imageUrl: `https://images.example.test/${ruleId}.jpg`,
    sourceUrl: `https://example.test/${ruleId}`, title: `Preserved ${ruleId} image article`, label: "An earlier display label",
    reason: "An earlier explanation", discoveredAt: oldTime };
}
function run(boundary: BlockingRule, criteriaKey = ruleCriteriaKey(boundary)): MemoryRuleRun {
  return { at: oldTime, reason: "manual", query: "Earlier actual criteria", resultCount: 1, imageExampleCount: 1, criteriaKey };
}
function response(xml = rss, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => xml } as Response;
}

let settings: Settings;
let stored: SpoilerMemory;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-30T12:00:00.000Z")); vi.clearAllMocks();
  settings = { ...DEFAULT_SETTINGS, memoryEnabled: true, rules: [rule()] };
  stored = normalizeMemory();
  localGet.mockImplementation(async () => ({ [MEMORY_KEY]: stored }));
  localSet.mockImplementation(async (value: Record<string, SpoilerMemory>) => { stored = value[MEMORY_KEY]!; });
  loadSettings.mockImplementation(async () => settings);
  updateStatus.mockResolvedValue(undefined);
  fetchMock.mockReset().mockResolvedValue(response());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("criteria-scoped public knowledge refresh", () => {
  it("keeps the public query and knowledge association unchanged when only a filter title changes", async () => {
    await refreshSpoilerMemory("manual");
    const firstUrl = fetchMock.mock.calls[0]![0] as string;
    const firstKey = stored.ruleRuns.orbit!.criteriaKey;
    const firstIds = stored.entries.map(({ id }) => id);
    settings = { ...settings, rules: [{ ...settings.rules[0]!, name: "DisplayBeta" }] };
    await refreshSpoilerMemory("alarm");
    expect(fetchMock.mock.calls[1]![0]).toBe(firstUrl);
    expect(stored.ruleRuns.orbit!.criteriaKey).toBe(firstKey);
    expect(stored.ruleRuns.orbit!.criteriaKey).toBe(ruleCriteriaKey(settings.rules[0]!));
    expect(stored.entries.map(({ id }) => id)).toEqual(firstIds);
    const query = new URL(firstUrl).searchParams.get("q")!;
    expect(query).toContain("orbital"); expect(query).toContain("stellar");
    expect(query).not.toMatch(/DisplayAlpha|DisplayBeta/i);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: "omit", cache: "no-store" });
  });

  it.each([
    { description: "", keywords: ["telescope"] },
    { description: "Orbital uprising", keywords: [] },
  ])("searches explicit criteria without using the display title: %j", async (criteria) => {
    settings.rules = [rule(criteria)];
    await refreshSpoilerMemory("manual");
    expect(fetchMock).toHaveBeenCalledOnce();
    const query = new URL(fetchMock.mock.calls[0]![0] as string).searchParams.get("q")!;
    expect(query).toContain(criteria.keywords[0] ?? "orbital");
    expect(query).not.toContain("displayalpha");
    expect(stored.ruleRuns.orbit!.criteriaKey).toBe(ruleCriteriaKey(settings.rules[0]!));
  });

  it.each([
    { description: "", keywords: [] },
    { description: "   ", keywords: [" ", ""] },
    { description: "latest news spoilers", keywords: [] },
  ])("does not fetch generic spoiler news for title-only or unsearchable criteria: %j", async (criteria) => {
    const boundary = rule(criteria);
    settings.rules = [boundary];
    const history = entry(boundary.id);
    stored = normalizeMemory({ entries: [history], imageExamples: [image(boundary.id)], ruleRuns: { orbit: run(boundary, "old-provenance") } });
    await refreshSpoilerMemory("manual");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stored.entries).toEqual([history]);
    expect(stored.ruleRuns.orbit!.criteriaKey).toBe("old-provenance");
  });

  it("does not fetch or discard a disabled filter's stored history", async () => {
    const boundary = rule({ enabled: false }); settings.rules = [boundary];
    const history = entry(boundary.id);
    stored = normalizeMemory({ entries: [history], ruleRuns: { orbit: run(boundary) } });
    await refreshSpoilerMemory("alarm");
    expect(fetchMock).not.toHaveBeenCalled(); expect(stored.entries).toEqual([history]);
  });

  it.each(["legacy", "mismatched"])("rebuilds only successfully refreshed %s knowledge before assigning current provenance", async (kind) => {
    const boundary = rule(); const untouchedRule = rule({ id: "untouched", enabled: false });
    const previousRun = run(boundary, ruleCriteriaKey({ ...boundary, description: "Different old criteria" }));
    if (kind === "legacy") delete previousRun.criteriaKey;
    const untouchedEntry = entry(untouchedRule.id); const untouchedImage = image(untouchedRule.id);
    stored = normalizeMemory({ entries: [entry(boundary.id), untouchedEntry], imageExamples: [image(boundary.id), untouchedImage],
      ruleRuns: { orbit: previousRun, untouched: run(untouchedRule) } });
    settings.rules = [boundary, untouchedRule];
    const untouchedRun = stored.ruleRuns.untouched;
    await refreshSpoilerMemory("manual");
    expect(stored.entries.filter(({ ruleId }) => ruleId === boundary.id).map(({ title }) => title)).toEqual(["Current orbital event reveals winning crew"]);
    expect(stored.imageExamples.filter(({ ruleId }) => ruleId === boundary.id).map(({ imageUrl }) => imageUrl)).toEqual(["https://images.example.test/current-orbit.jpg"]);
    expect(stored.entries).toContainEqual(untouchedEntry); expect(stored.imageExamples).toContainEqual(untouchedImage);
    expect(stored.ruleRuns.untouched).toEqual(untouchedRun);
    expect(stored.ruleRuns.orbit!.criteriaKey).toBe(ruleCriteriaKey(boundary));
  });

  it("does not rehabilitate mismatched old knowledge when the successful refresh returns no results", async () => {
    const boundary = rule();
    stored = normalizeMemory({ entries: [entry(boundary.id)], imageExamples: [image(boundary.id)], ruleRuns: { orbit: run(boundary, "old-provenance") } });
    fetchMock.mockResolvedValue(response("<rss><channel></channel></rss>"));
    await refreshSpoilerMemory("manual");
    expect(stored.entries).toEqual([]); expect(stored.imageExamples).toEqual([]);
    expect(stored.ruleRuns.orbit).toMatchObject({ criteriaKey: ruleCriteriaKey(boundary), resultCount: 0, imageExampleCount: 0 });
  });

  it("keeps stored history and its old provenance when refreshing changed criteria fails", async () => {
    const boundary = rule(); const previousRun = run(boundary, "old-provenance");
    const previousEntries = [entry(boundary.id)]; const previousImages = [image(boundary.id)];
    stored = normalizeMemory({ entries: previousEntries, imageExamples: previousImages, ruleRuns: { orbit: previousRun } });
    fetchMock.mockResolvedValue(response("", 503));
    await refreshSpoilerMemory("manual");
    expect(stored.entries).toEqual(previousEntries); expect(stored.imageExamples).toEqual(previousImages);
    expect(stored.ruleRuns.orbit).toEqual(previousRun); expect(stored.lastError).toContain("503");
  });

  it("merges earlier trusted results when the criteria association still matches after a rename", async () => {
    const boundary = rule(); const history = entry(boundary.id); const oldImage = image(boundary.id);
    stored = normalizeMemory({ entries: [history], imageExamples: [oldImage], ruleRuns: { orbit: run(boundary) } });
    settings.rules = [{ ...boundary, name: "A different display name" }];
    await refreshSpoilerMemory("manual");
    expect(stored.entries).toContainEqual(history); expect(stored.imageExamples).toContainEqual(oldImage);
    expect(stored.entries).toHaveLength(2); expect(stored.imageExamples).toHaveLength(2);
    expect(stored.ruleRuns.orbit!.criteriaKey).toBe(ruleCriteriaKey(boundary));
  });
});
