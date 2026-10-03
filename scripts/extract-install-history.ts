// Propose install-base changes from watchlist items and archive news with the
// active stack's model. Writes only config/install-history.local.yaml.
//
// Usage:
//   npx tsx scripts/extract-install-history.ts [--dry-run]
//   npx tsx scripts/extract-install-history.ts --status
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAccounts } from "../src/services/graph-accounts.js";
import { parseVendorBrief } from "../src/services/graph-schema.js";
import {
  candidates,
  historyStatusReport,
  historyVendorNames,
  runHistoryExtraction,
  type NewsItem,
} from "../src/services/install-history-extract.js";
import {
  INSTALL_HISTORY_FILE,
  parseInstallHistory,
  mergeInstallHistoryText,
  type InstallHistoryFile,
} from "../src/services/install-history.js";
import { getLlmClient } from "../src/services/llm-client.js";
import { listRawDocuments } from "../src/services/raw-documents.js";
import { loadWatchlist } from "../src/services/watchlist-config.js";
import { openWatchlistStore } from "../src/services/watchlist-store.js";

// A bad file or flag is the user's to fix: one line on stderr, not a stack trace
function fail(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

const root = process.cwd();
const dryRun = process.argv.includes("--dry-run");
const filePath = join(root, INSTALL_HISTORY_FILE);
const readText = (): string => (existsSync(filePath) ? readFileSync(filePath, "utf8") : "");
function parseOnDisk(text: string): InstallHistoryFile {
  try {
    return parseInstallHistory(text);
  } catch (err) {
    throw new Error(`${INSTALL_HISTORY_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
const read = (): InstallHistoryFile => parseOnDisk(readText());

if (process.argv.includes("--status")) {
  for (const line of historyStatusReport(read())) console.log(line);
  process.exit(0);
}

const accountsPath = join(root, "config", "accounts.local.yaml");
if (!existsSync(accountsPath)) {
  console.error("declare accounts first: copy config/accounts.example.yaml to config/accounts.local.yaml");
  process.exit(1);
}
const parsedAccounts = parseAccounts(readFileSync(accountsPath, "utf8"));
const accounts = parsedAccounts.map((a) => ({ id: a.id, names: [a.id, a.name, ...a.aliases] }));
// The graph's own vendor ids (briefs and the accounts file), with the watchlist
// names of the same entity: a proposal must use the ids the rebuild knows.
const graphVendorIds = new Set<string>();
const briefsDir = join(root, "knowledge", "vendors");
for (const f of existsSync(briefsDir) ? readdirSync(briefsDir).filter((n) => n.endsWith(".md")) : []) {
  graphVendorIds.add(parseVendorBrief(readFileSync(join(briefsDir, f), "utf8")).vendor);
}
for (const a of parsedAccounts) for (const list of Object.values(a.history)) for (const s of list ?? []) graphVendorIds.add(s.vendor);
const vendors = historyVendorNames([...graphVendorIds].sort(), [...loadWatchlist().entities.values()]);

const items: NewsItem[] = [];
const dbPath = join(root, "data", "watchlist.db");
if (existsSync(dbPath)) {
  const store = openWatchlistStore(dbPath, { readonly: true });
  try {
    for (const it of store.itemsInPeriod("0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", { entities: accounts.map((a) => a.id) })) {
      items.push({ key: it.urlCanonical, source: it.urlCanonical, date: it.publishedAt.slice(0, 10), text: [it.title, it.summary, it.body].join("\n\n").slice(0, 6000) });
    }
  } finally {
    store.close();
  }
}
for (const doc of await listRawDocuments()) {
  const day = /^news-(\d{4}-\d{2}-\d{2})$/.exec(doc.source)?.[1];
  // One source per day for archive news: the key that resumes a run is per document.
  const key = `${doc.source}#${createHash("sha256").update(doc.content).digest("hex").slice(0, 12)}`;
  if (day !== undefined) items.push({ key, source: doc.source, date: day, text: doc.content.slice(0, 6000) });
}

const cands = candidates(items, accounts, vendors);
console.log(`${items.length} items, ${cands.length} name an account and a vendor`);

const llm = getLlmClient();
if (!(await llm.isReachable())) {
  console.error(`the active stack (${llm.stack.name}) is not reachable: start it before extracting`);
  process.exit(1);
}

function save(fromRun: InstallHistoryFile): void {
  // Appends to the text on disk, so the user's comments and extra fields survive.
  const onDisk = readText();
  parseOnDisk(onDisk);
  writeFileSync(`${filePath}.tmp`, mergeInstallHistoryText(onDisk, fromRun));
  renameSync(`${filePath}.tmp`, filePath);
}

const result = await runHistoryExtraction(
  read(),
  cands,
  {
    complete: (prompt) => llm.chat([{ role: "user", content: prompt }], { temperature: 0.1 }),
    today: () => new Date().toISOString().slice(0, 10),
    log: (line) => console.log(line),
  },
  { onItem: dryRun ? undefined : save },
);

for (const e of result.proposed) console.log(`+ ${e.id}  ${e.account} / ${e.segment}  ${e.change} ${e.vendor}  ${e.date}  — "${e.quote}"`);
const dropped = Object.entries(result.dropped).filter(([, n]) => n > 0).map(([r, n]) => `${n} ${r}`);
console.log(`\n${result.proposed.length} proposed, ${result.skipped} already processed, ${result.failed} failed${dropped.length > 0 ? `, dropped: ${dropped.join(", ")}` : ""}`);
if (dryRun) console.log("DRY RUN: nothing written");
else {
  save(result.file);
  console.log(`written: ${INSTALL_HISTORY_FILE} (approve entries by changing their status)`);
}
