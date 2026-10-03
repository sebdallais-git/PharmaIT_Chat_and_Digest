// Propose install-base changes from watchlist items and archive news with the
// active stack's model. Writes only config/install-history.local.yaml.
//
// Usage:
//   npx tsx scripts/extract-install-history.ts [--dry-run]
//   npx tsx scripts/extract-install-history.ts --status
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAccounts } from "../src/services/graph-accounts.js";
import { candidates, historyStatusReport, runHistoryExtraction, type NewsItem } from "../src/services/install-history-extract.js";
import {
  INSTALL_HISTORY_FILE,
  mergeInstallHistory,
  parseInstallHistory,
  renderInstallHistory,
  type InstallHistoryFile,
} from "../src/services/install-history.js";
import { getLlmClient } from "../src/services/llm-client.js";
import { listRawDocuments } from "../src/services/raw-documents.js";
import { loadWatchlist } from "../src/services/watchlist-config.js";
import { openWatchlistStore } from "../src/services/watchlist-store.js";

const root = process.cwd();
const dryRun = process.argv.includes("--dry-run");
const filePath = join(root, INSTALL_HISTORY_FILE);
const read = (): InstallHistoryFile =>
  existsSync(filePath) ? parseInstallHistory(readFileSync(filePath, "utf8")) : { sources: {}, entries: [] };

if (process.argv.includes("--status")) {
  for (const line of historyStatusReport(read())) console.log(line);
  process.exit(0);
}

const accountsPath = join(root, "config", "accounts.local.yaml");
if (!existsSync(accountsPath)) {
  console.error("declare accounts first: copy config/accounts.example.yaml to config/accounts.local.yaml");
  process.exit(1);
}
const accounts = parseAccounts(readFileSync(accountsPath, "utf8")).map((a) => ({ id: a.id, names: [a.id, a.name, ...a.aliases] }));
const vendors = [...loadWatchlist().entities.values()]
  .filter((e) => e.kind === "vendor")
  .map((e) => ({ id: e.id, names: [e.id, e.name, ...e.aliases] }));

const items: NewsItem[] = [];
const dbPath = join(root, "data", "watchlist.db");
if (existsSync(dbPath)) {
  const store = openWatchlistStore(dbPath);
  try {
    for (const it of store.itemsInPeriod("0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", { entities: accounts.map((a) => a.id) })) {
      items.push({ source: it.urlCanonical, date: it.publishedAt.slice(0, 10), text: [it.title, it.summary, it.body].join("\n\n").slice(0, 6000) });
    }
  } finally {
    store.close();
  }
}
for (const doc of await listRawDocuments()) {
  const day = /^news-(\d{4}-\d{2}-\d{2})$/.exec(doc.source)?.[1];
  if (day !== undefined) items.push({ source: doc.source, date: day, text: doc.content.slice(0, 6000) });
}

const cands = candidates(items, accounts, vendors);
console.log(`${items.length} items, ${cands.length} name an account and a vendor`);

const llm = getLlmClient();
if (!(await llm.isReachable())) {
  console.error(`the active stack (${llm.stack.name}) is not reachable: start it before extracting`);
  process.exit(1);
}

function save(fromRun: InstallHistoryFile): void {
  writeFileSync(`${filePath}.tmp`, renderInstallHistory(mergeInstallHistory(read(), fromRun)));
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
