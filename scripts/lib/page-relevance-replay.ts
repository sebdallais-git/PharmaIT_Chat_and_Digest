// Pure pieces of scripts/replay-page-relevance.ts: reading n8n's stored gap
// runs into (page, did the 27B keep it) pairs, and summarising the replay.

// n8n stores execution data in the "flatted" format: a single JSON array in
// which a string of digits inside an object or array refers to another entry.
export function unflatten(text: string): unknown {
  const table = JSON.parse(text) as unknown[];
  const memo = new Map<number, unknown>();
  const ref = (v: unknown): unknown => (typeof v === "string" && /^\d+$/.test(v) ? at(Number(v)) : v);
  function at(i: number): unknown {
    if (memo.has(i)) return memo.get(i);
    const v = table[i];
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      memo.set(i, out);
      for (const x of v) out.push(ref(x));
      return out;
    }
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      memo.set(i, out);
      for (const [k, x] of Object.entries(v)) out[k] = ref(x);
      return out;
    }
    memo.set(i, v);
    return v;
  }
  return at(0);
}

// The same rule as the workflow's "Filter Relevant Only" node, which a test
// checks by running that node's code. Null: the extraction failed, so the 27B
// gave no verdict on the page.
const NOT_RELEVANT =
  /NOT_RELEVANT|\bnot relevant\b|\birrelevant\b|\bno (relevant|useful) (information|content)\b|\bdoes not (contain|include|provide|mention) any\b/i;

export function keptByFilter(extraction: Record<string, unknown>): boolean | null {
  if (extraction.error) return null;
  const response = String(extraction.response ?? "").trim();
  if (response.startsWith("NOT_RELEVANT")) return false;
  if (NOT_RELEVANT.test(response.slice(0, 250))) return false;
  return response.length >= 50;
}

export interface ReplayPage {
  exec: number;
  url: string;
  topic: string;
  page: string;
  kept: boolean;
}

type RunData = Record<string, unknown>;

function itemsOf(run: unknown): Record<string, unknown>[] {
  const main = (run as { data?: { main?: unknown[] } })?.data?.main;
  const first = Array.isArray(main) ? main[0] : undefined;
  if (!Array.isArray(first)) return [];
  return first.map((x) => ((x as { json?: Record<string, unknown> })?.json ?? {}));
}

function runsOf(runData: RunData, node: string): unknown[] {
  const runs = runData[node];
  return Array.isArray(runs) ? runs : [];
}

/** Each fetched page of one gap run, with whether the workflow kept the 27B's extraction of it. */
export function pagesFromRunData(exec: number, runData: RunData): ReplayPage[] {
  const pages: ReplayPage[] = [];
  const sources = runsOf(runData, "Truncate & Clean Content");
  const extractions = runsOf(runData, "Extract Knowledge (Ollama)");
  for (let r = 0; r < Math.min(sources.length, extractions.length); r += 1) {
    const src = itemsOf(sources[r]);
    const out = itemsOf(extractions[r]);
    for (let i = 0; i < Math.min(src.length, out.length); i += 1) {
      const kept = keptByFilter(out[i]);
      const page = src[i].page_content;
      if (kept === null || typeof page !== "string" || page === "") continue;
      pages.push({
        exec,
        url: String(src[i].url ?? ""),
        topic: String(src[i].search_topic ?? ""),
        page,
        kept,
      });
    }
  }
  return pages;
}

export interface ReportRow {
  threshold: number;
  // Pages the 27B discarded that the scorer would have skipped: time saved
  skippedDiscarded: number;
  // Pages the 27B kept that the scorer would have skipped: knowledge lost
  lostKept: number;
}

export function reportRows(pages: { kept: boolean; p: number }[], thresholds: number[]): ReportRow[] {
  return thresholds.map((threshold) => {
    const skipped = pages.filter((x) => x.p < threshold);
    return {
      threshold,
      skippedDiscarded: skipped.filter((x) => !x.kept).length,
      lostKept: skipped.filter((x) => x.kept).length,
    };
  });
}
