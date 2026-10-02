// Propose need evidence from the legacy documents with the active stack's model.
//
// Usage:
//   npx tsx scripts/extract-need-evidence.ts [--only knowledge/<file>] [--dry-run]
//   npx tsx scripts/extract-need-evidence.ts --status      read-only review summary
//
// Writes only config/need-evidence.local.yaml (gitignored). Approve entries by
// changing their status; the next graph rebuild picks up approved ones.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFile } from "../src/services/file-parser.js";
import { parseAccounts } from "../src/services/graph-accounts.js";
import { getLlmClient } from "../src/services/llm-client.js";
import { NEED_EVIDENCE_FILE, parseNeedEvidence, renderNeedEvidence } from "../src/services/need-evidence.js";
import { legacyDocuments, parseExtractArgs, runExtraction, statusReport } from "../src/services/need-evidence-extract.js";

const root = process.cwd();
const args = parseExtractArgs(process.argv.slice(2));
const filePath = join(root, NEED_EVIDENCE_FILE);
const file = existsSync(filePath) ? parseNeedEvidence(readFileSync(filePath, "utf8")) : { sources: {}, entries: [] };

if (args.status) {
  for (const line of statusReport(file)) console.log(line);
  process.exit(0);
}

const accountsPath = join(root, "config", "accounts.local.yaml");
if (!existsSync(accountsPath)) {
  console.error("declare accounts first: copy config/accounts.example.yaml to config/accounts.local.yaml");
  process.exit(1);
}
const accounts = parseAccounts(readFileSync(accountsPath, "utf8"));

const llm = getLlmClient();
if (!(await llm.isReachable())) {
  console.error(`the active stack (${llm.stack.name}) is not reachable: start it before extracting`);
  process.exit(1);
}

const result = await runExtraction(file, accounts, {
  documents: () => legacyDocuments(readdirSync(join(root, "knowledge"))),
  read: (path) => parseFile(join(root, path)),
  complete: (prompt) => llm.chat([{ role: "user", content: prompt }], { temperature: 0.1 }),
  today: () => new Date().toISOString().slice(0, 10),
  log: (line) => console.log(line),
}, { only: args.only });

for (const e of result.proposed) console.log(`+ ${e.id}  ${e.account} / ${e.need}  ${e.claim}  — "${e.quote}" (${e.source})`);
const dropped = Object.entries(result.dropped).filter(([, n]) => n > 0).map(([reason, n]) => `${n} ${reason}`);
console.log(
  `\n${result.proposed.length} proposed, ${result.skippedDocs} unchanged documents skipped, ` +
    `${result.failedChunks} chunks failed${dropped.length > 0 ? `, dropped: ${dropped.join(", ")}` : ""}`,
);

if (args.dryRun) {
  console.log("DRY RUN: nothing written");
} else {
  writeFileSync(filePath, renderNeedEvidence(result.file));
  console.log(`written: ${NEED_EVIDENCE_FILE} (approve entries by changing their status)`);
}
