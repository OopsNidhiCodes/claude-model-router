#!/usr/bin/env node
// Downloads English, single-turn user prompts from WildChat (HuggingFace) and
// writes them to ml/data/wildchat-raw.jsonl. Each row: { id, prompt }.
//
// Usage:  node ml/download-wildchat.mjs [--limit 10000]
//
// Requires a HuggingFace token with read access in HF_TOKEN (free).
// The dataset is allenai/WildChat-1M (public, ~1M conversations).
// We pull from the "train" split via the HF datasets REST API.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const HF_TOKEN = process.env.HF_TOKEN;
if (!HF_TOKEN) {
  console.error("HF_TOKEN is not set. Get a free token at https://huggingface.co/settings/tokens");
  console.error("  HF_TOKEN=hf_... node ml/download-wildchat.mjs");
  process.exit(1);
}

const limit = (() => {
  const idx = process.argv.indexOf("--limit");
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : 10000;
})();

const DATASET = "allenai/WildChat-1M";
const SPLIT = "train";
const PAGE_SIZE = 100;
const API = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}&config=default&split=${SPLIT}`;

const key = (p) => createHash("sha1").update(p).digest("hex").slice(0, 10);

const outPath = new URL("./data/wildchat-raw.jsonl", import.meta.url);

// Resume from existing file if present.
const seen = new Set();
const rows = [];
if (existsSync(outPath)) {
  for (const line of readFileSync(outPath, "utf8").trim().split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line);
    seen.add(r.id);
    rows.push(r);
  }
  console.log(`Resuming: ${rows.length} prompts already downloaded`);
}
let offset = 0;

console.log(`Downloading up to ${limit} English single-turn prompts from ${DATASET}...`);

while (rows.length < limit) {
  const url = `${API}&offset=${offset}&length=${PAGE_SIZE}`;
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(url, { headers: { Authorization: `Bearer ${HF_TOKEN}` } });
    if (res.status === 429) {
      const wait = parseInt(res.headers.get("retry-after") ?? String(10 * (attempt + 1)), 10);
      console.log(`\n  Rate limited, waiting ${wait}s (attempt ${attempt + 1}/5)...`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    break;
  }
  if (!res.ok) {
    if (res.status === 404 || res.status === 422) {
      console.log(`Reached end of dataset at offset ${offset}`);
      break;
    }
    throw new Error(`HF API ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const batch = data.rows ?? [];
  if (batch.length === 0) break;

  for (const { row } of batch) {
    if (rows.length >= limit) break;
    const convo = row.conversation;
    if (!Array.isArray(convo)) continue;

    // Single-turn only: exactly one user message, optionally followed by an assistant reply.
    const userMsgs = convo.filter((m) => m.role === "user");
    if (userMsgs.length !== 1) continue;

    const prompt = userMsgs[0].content?.trim();
    if (!prompt || prompt.length < 10 || prompt.length > 4000) continue;

    // English only (the dataset has a language field).
    if (row.language && row.language !== "English") continue;

    // Skip duplicates.
    const id = key(prompt);
    if (seen.has(id)) continue;
    seen.add(id);

    rows.push({ id, prompt });
  }

  offset += batch.length;
  if (rows.length % 100 < PAGE_SIZE) {
    writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    process.stdout.write(`\r  ${rows.length} prompts collected (offset ${offset})...`);
  }
}

console.log(`\n${rows.length} prompts collected.`);

writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`Wrote ${outPath.pathname}`);
