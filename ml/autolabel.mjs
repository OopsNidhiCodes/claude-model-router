#!/usr/bin/env node
// Auto-labels prompts from wildchat-raw.jsonl (or any raw JSONL with { id, prompt })
// by sending batches through the Groq proxy with a tier-classification rubric.
//
// Usage:
//   node ml/autolabel.mjs [--input data/wildchat-raw.jsonl] [--limit 5000]
//                         [--concurrency 4] [--batch 10] [--proxy http://localhost:4000]
//
// Prerequisites:
//   1. LiteLLM proxy running: GROQ_API_KEY=gsk_... scripts/start-proxy.sh
//   2. The proxy serves the OpenAI-compatible route on http://localhost:4000
//
// Prompts are batched because Groq's free tier limits requests, not tokens, so
// one call per prompt is the throughput ceiling. Unsafe and near-duplicate
// prompts are skipped before a call is spent on them.
//
// Resumable: already-labelled ids are skipped, so re-running tops up the file.
// Output: ml/data/wildchat-labelled.jsonl  (merged by merge-labels.mjs)

import { readFileSync, existsSync, openSync, writeSync, closeSync } from "node:fs";

const LABELLING_RUBRIC = `You are a prompt difficulty classifier for an AI coding assistant. Classify each user prompt into exactly one difficulty tier.

## Tiers

- **trivial**: Quick, low-stakes tasks. Greetings, one-line facts, formatting, short rewrites, spell checking, simple lookups, "what does X mean", converting units, explaining a single error, renaming a variable, a one-line creative request. A fast, cheap model handles these perfectly.

- **standard**: Everyday tasks requiring real work but no deep reasoning. Summaries, explanations, writing a single function, implementing a component, fixing a straightforward bug, writing unit tests, code review of a small change, adding validation, Q&A with moderate context. Substantial creative writing (stories, scripts, articles, roleplay) is standard. The bread-and-butter tier.

- **complex**: Multi-step reasoning, multi-file code changes, detailed analysis, architecture decisions, debugging intermittent issues, security audits, performance investigation, root cause analysis, system design, trade-off analysis. Requires sustained attention and deep understanding.

- **expert**: Long-running agentic tasks only: end-to-end migrations, iterating until tests pass, running and fixing builds, multi-step automation, or tasks where the model must autonomously execute commands and verify results across many steps. Never use expert for creative writing.

## Rules
- Classify the prompt itself, not the topic. A simple question about a complex topic is still trivial.
- When the prompt is ambiguous, lean toward the middle (standard).
- Code context size matters: a 2-line snippet is simpler than a 500-line file even if the question is the same.
- "Fix this bug" with a clear error is standard; "debug why this sometimes fails" is complex.`;

const TIER_TO_FAMILY = { trivial: "haiku", standard: "sonnet", complex: "opus", expert: "fable" };
const VALID_TIERS = new Set(Object.keys(TIER_TO_FAMILY));

// Prompts not worth a call: content the labeller refuses, or recurring
// jailbreak/fetish series that were dropped by hand from an earlier run.
const SKIP_PROMPT =
  /Patricia (Hertig|Bertier)|Caroline Hertig|Chris Vaughn|reality shifting|The Sacred Paradox|erotic|tickl|inflated\b|\bDAN\b|ignore previous instructions/i;

const arg = (name, def) => {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : def;
};
const inputPath = arg("--input", "data/wildchat-raw.jsonl");
const limitArg = parseInt(arg("--limit", "5000"), 10);
const concurrency = parseInt(arg("--concurrency", "4"), 10);
const batchSize = Math.max(1, parseInt(arg("--batch", "10"), 10));
const proxyUrl = arg("--proxy", "http://localhost:4000");
const model = arg("--model", "claude-haiku-5-5");

const fullInput = new URL(`./${inputPath}`, import.meta.url);
if (!existsSync(fullInput)) {
  console.error(`Input file not found: ${fullInput.pathname}`);
  console.error("Run: node ml/download-wildchat.mjs first");
  process.exit(1);
}
const raw = readFileSync(fullInput, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

const outPath = new URL("./data/wildchat-labelled.jsonl", import.meta.url);
const doneIds = new Set();
const seenPrefix = new Set();
if (existsSync(outPath)) {
  for (const line of readFileSync(outPath, "utf8").trim().split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line);
    doneIds.add(r.id);
    seenPrefix.add(r.prompt.slice(0, 60).replace(/\s+/g, " ").toLowerCase());
  }
}

// Build the work list, skipping what we would discard later anyway.
let skippedUnsafe = 0, skippedDupe = 0;
const queue = [];
for (const item of raw) {
  if (queue.length >= limitArg) break;
  if (doneIds.has(item.id)) continue;
  if (SKIP_PROMPT.test(item.prompt)) { skippedUnsafe++; continue; }
  const prefix = item.prompt.slice(0, 60).replace(/\s+/g, " ").toLowerCase();
  if (seenPrefix.has(prefix)) { skippedDupe++; continue; }
  seenPrefix.add(prefix);
  queue.push(item);
}

console.log(`Labelling via ${proxyUrl} (model ${model}, batch ${batchSize}, concurrency ${concurrency})`);
console.log(`  ${doneIds.size} already labelled, ${queue.length} to do`);
console.log(`  skipped before calling: ${skippedUnsafe} unsafe, ${skippedDupe} near-duplicate`);
if (queue.length === 0) process.exit(0);

const batches = [];
for (let i = 0; i < queue.length; i += batchSize) batches.push(queue.slice(i, i + batchSize));

/** Asks for one numbered tier per prompt and returns a Map of index -> tier. */
async function labelBatch(batch) {
  const listed = batch
    .map((it, i) => `### Prompt ${i + 1}\n${it.prompt.slice(0, 1200).replace(/\s+/g, " ")}`)
    .join("\n\n");
  const body = {
    model,
    max_tokens: 200 + 80 * batch.length,
    temperature: 0,
    messages: [
      { role: "system", content: LABELLING_RUBRIC },
      {
        role: "user",
        content:
          `Classify each of the ${batch.length} prompts below.\n\n` +
          `Output exactly ${batch.length} lines and nothing else. Each line must be ` +
          `"<number>: <tier>", where tier is trivial, standard, complex or expert. ` +
          `No explanation, no reasoning.\n\n${listed}`,
      },
    ],
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(`${proxyUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-local-proxy" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt === 2) return new Map();
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const wait = parseInt(res.headers.get("retry-after") ?? String(5 * (attempt + 1)), 10);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) return new Map();

    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    // GPT-OSS sometimes leaves content empty and puts the answer in "reasoning".
    const text = `${msg.content ?? ""}\n${msg.reasoning ?? ""}`;
    const out = new Map();
    // Not anchored to line starts: the model often returns every answer on one line.
    for (const m of text.matchAll(/\b(\d+)\s*[:.)-]\s*\**\s*(trivial|standard|complex|expert)\b/gi)) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < batch.length && !out.has(idx)) out.set(idx, m[2].toLowerCase());
    }
    return out;
  }
  return new Map();
}

const fd = openSync(outPath, existsSync(outPath) ? "a" : "w");
let batchesDone = 0, written = 0, unmatched = 0;

async function worker() {
  while (batches.length > 0) {
    const batch = batches.shift();
    const answers = await labelBatch(batch);
    batch.forEach((item, i) => {
      const tier = answers.get(i);
      if (!tier || !VALID_TIERS.has(tier)) { unmatched++; return; }
      writeSync(fd, JSON.stringify({
        id: item.id, prompt: item.prompt, tier, label: TIER_TO_FAMILY[tier], source: "wildchat-auto",
      }) + "\n");
      written++;
    });
    if (++batchesDone % 10 === 0) {
      process.stdout.write(`\r  ${batchesDone}/${batchesDone + batches.length} batches, ${written} labelled, ${unmatched} unmatched`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
closeSync(fd);

const dist = {};
for (const line of readFileSync(outPath, "utf8").trim().split("\n")) {
  if (!line) continue;
  const r = JSON.parse(line);
  dist[r.label] = (dist[r.label] ?? 0) + 1;
}
console.log(`\n${written} new labels (${unmatched} unmatched). Total in file: ${Object.values(dist).reduce((a, b) => a + b, 0)}`);
console.log("Distribution:", dist);
