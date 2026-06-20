export type Strictness = "loose" | "balanced" | "strict";
export type RedactionStyle = "marker" | "whiteout";

export interface BlockingRule {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  enabled: boolean;
}

export interface Settings {
  version: 2;
  enabled: boolean;
  scanText: boolean;
  scanImages: boolean;
  useLocalAI: boolean;
  useVision: boolean;
  memoryEnabled: boolean;
  memoryRefreshHours: number;
  memoryMaxEntriesPerRule: number;
  memoryMaxImageExamplesPerRule: number;
  strictness: Strictness;
  redactionStyle: RedactionStyle;
  maxTextNodesPerScan: number;
  maxImagesPerScan: number;
  rules: BlockingRule[];
}

export interface Match {
  ruleId: string;
  ruleName: string;
  reason: string;
}

export interface ScanCounters {
  text: number;
  images: number;
  aiText: number;
  aiImages: number;
}

export type ModelState =
  | "unknown"
  | "checking"
  | "downloadable"
  | "downloading"
  | "available"
  | "recovering"
  | "fallback"
  | "metadata fallback"
  | "unavailable";

export interface MemorySummary {
  enabled: boolean;
  lastUpdatedAt: string;
  lastError: string;
  entryCount: number;
  imageExampleCount: number;
  ruleRuns: Record<string, MemoryRuleRun>;
}

export interface ExtensionStatus {
  enabled: boolean;
  counters: ScanCounters;
  aiText: ModelState;
  aiVision: ModelState;
  aiDownload?: number | undefined;
  aiReason: string;
  lastError: string;
  lastScanAt: string;
  pendingText: number;
  pendingImages: number;
  updatedAt: string;
  memory: MemorySummary;
}

export interface MemoryEntry {
  id: string;
  ruleId: string;
  title: string;
  snippet: string;
  url: string;
  source: string;
  publishedAt: string;
  discoveredAt: string;
  terms: string[];
  reason: string;
}

export interface MemoryImageExample {
  id: string;
  ruleId: string;
  imageUrl: string;
  sourceUrl: string;
  title: string;
  label: string;
  reason: string;
  discoveredAt: string;
}

export interface MemoryRuleRun {
  at: string;
  reason: string;
  query: string;
  resultCount: number;
  imageExampleCount: number;
}

export interface SpoilerMemory {
  version: 1;
  enabled: boolean;
  lastUpdatedAt: string;
  lastError: string;
  entries: MemoryEntry[];
  imageExamples: MemoryImageExample[];
  ruleRuns: Record<string, MemoryRuleRun>;
}
