#!/usr/bin/env node
// Merges all labelled data sources into one training file.
//
// Sources (in priority order — later sources don't overwrite earlier labels):
//   1. ml/data/seed.jsonl          (hand-written examples)
//   2. ml/data/real.jsonl          (session exports with manual labels)
//   3. ml/data/wildchat-labelled.jsonl  (auto-labelled WildChat prompts)
//
// Output: ml/data/merged.jsonl — the combined training set for train.mjs
//
// Usage:  node ml/merge-labels.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";

function readJsonl(relPath) {
  const fullPath = new URL(relPath, import.meta.url);
  if (!existsSync(fullPath)) return [];
  return readFileSync(fullPath, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l)
    .map((l) => JSON.parse(l));
}

const seed = readJsonl("./data/seed.jsonl");
const real = readJsonl("./data/real.jsonl").filter((r) => r.label);
const wildchat = readJsonl("./data/wildchat-labelled.jsonl").filter((r) => r.label);

const seen = new Set();
const rows = [];

function addRows(source, tag) {
  let added = 0;
  for (const r of source) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    rows.push({ id: r.id, prompt: r.prompt, label: r.label, source: tag });
    added++;
  }
  return added;
}

const nSeed = addRows(seed, "written");
const nReal = addRows(real, "session-export");
const nWild = addRows(wildchat, "wildchat-auto");

const outPath = new URL("./data/merged.jsonl", import.meta.url);
writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const dist = {};
for (const r of rows) dist[r.label] = (dist[r.label] ?? 0) + 1;

console.log(`Merged training set: ${rows.length} examples`);
console.log(`  seed: ${nSeed}, real: ${nReal}, wildchat: ${nWild}`);
console.log(`  Distribution:`, dist);
console.log(`Wrote ${outPath.pathname}`);
