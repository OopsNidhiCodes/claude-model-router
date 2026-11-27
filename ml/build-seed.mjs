#!/usr/bin/env node
// Builds ml/data/seed.jsonl from ml/data/seed.tsv, which is the editable source.
//
//   node ml/build-seed.mjs        (or: npm run seed)
//
// seed.tsv format, one example per line:
//   <label><TAB><prompt>
// where label is haiku, sonnet, opus or fable. Blank lines and lines starting
// with # are ignored. Ids are sha1(prompt)[:10], the same scheme extract.mjs
// uses, so a prompt keeps its id across rebuilds.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const FAMILIES = new Set(["haiku", "sonnet", "opus", "fable"]);
const key = (p) => createHash("sha1").update(p).digest("hex").slice(0, 10);

const tsvPath = new URL("./data/seed.tsv", import.meta.url);
const lines = readFileSync(tsvPath, "utf8").split("\n");

const rows = [];
const seen = new Map();
const problems = [];
let duplicates = 0;

lines.forEach((line, i) => {
  const raw = line.replace(/\r$/, "");
  if (!raw.trim() || raw.startsWith("#")) return;

  const tab = raw.indexOf("\t");
  if (tab === -1) {
    problems.push(`line ${i + 1}: no tab separator — ${raw.slice(0, 60)}`);
    return;
  }
  const label = raw.slice(0, tab).trim().toLowerCase();
  const prompt = raw.slice(tab + 1).trim();

  if (!FAMILIES.has(label)) {
    problems.push(`line ${i + 1}: unknown label "${label}"`);
    return;
  }
  if (!prompt) {
    problems.push(`line ${i + 1}: empty prompt`);
    return;
  }

  const id = key(prompt);
  const prev = seen.get(id);
  if (prev) {
    duplicates++;
    if (prev !== label) problems.push(`line ${i + 1}: duplicate prompt labelled both ${prev} and ${label} — ${prompt.slice(0, 50)}`);
    return;
  }
  seen.set(id, label);
  rows.push({ id, prompt, label, source: "written" });
});

if (problems.length) {
  console.error(`${problems.length} problem(s) in seed.tsv:`);
  for (const p of problems) console.error(`  ${p}`);
  if (problems.some((p) => p.includes("labelled both"))) {
    console.error("\nConflicting labels for the same prompt — fix seed.tsv before training.");
    process.exit(1);
  }
}

// Field order and spacing match the original file, so a rebuild shows no
// spurious diff for rows that did not change.
const line = (r) =>
  `{"id": ${JSON.stringify(r.id)}, "prompt": ${JSON.stringify(r.prompt)}, ` +
  `"label": ${JSON.stringify(r.label)}, "source": ${JSON.stringify(r.source)}}`;

const outPath = new URL("./data/seed.jsonl", import.meta.url);
writeFileSync(outPath, rows.map(line).join("\n") + "\n");

const dist = {};
for (const r of rows) dist[r.label] = (dist[r.label] ?? 0) + 1;
console.log(`${rows.length} seed examples${duplicates ? ` (${duplicates} duplicate line(s) skipped)` : ""}`);
console.log("Distribution:", dist);
console.log(`Wrote ${outPath.pathname}`);
