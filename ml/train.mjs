// Trains the prompt classifier: multinomial logistic regression over the
// features in src/core/features.ts, with plain Node and no dependencies.
//
//   npm run train      (compiles first, so features.ts and the trainer agree)
//
// Data: ml/data/real.jsonl (from the session exports) and ml/data/seed.jsonl
// (written examples). 20% of the real prompts are held out and never trained
// on; accuracy on them is compared against the keyword rules. The model is
// written to resources/classifier-model.json.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { featurize } = require("../out/src/core/features.js");
const { classify: rules } = require("../out/src/core/classifier.js");
const { TIERS, FAMILY_TO_TIER } = require("../out/src/core/types.js");

// The data is labelled by family; the model speaks difficulty tiers, so labels
// are mapped on the way in. TIERS order fixes the class indices.
const CLASSES = [...TIERS];
const toTier = (label) => FAMILY_TO_TIER[label] ?? label;
const asTier = (r) => ({ ...r, label: toTier(r.label) });
const HOLDOUT = 0.2;
const MIN_COUNT = 2;
const EPOCHS = 40;
const LR = 0.1;
const L2 = 1e-4;
const SEED = 42;

const readJsonl = (p) => readFileSync(new URL(p, import.meta.url), "utf8").trim().split("\n").filter((l) => l).map((l) => JSON.parse(l));

// Use merged dataset if available (includes wildchat), else fall back to original sources.
const hasMerged = (() => { try { readFileSync(new URL("./data/merged.jsonl", import.meta.url)); return true; } catch { return false; } })();
const real = hasMerged
  ? readJsonl("./data/merged.jsonl").filter((r) => r.label && r.source !== "written").map(asTier)
  : readJsonl("./data/real.jsonl").filter((r) => r.label).map(asTier);
const seed = hasMerged
  ? readJsonl("./data/merged.jsonl").filter((r) => r.source === "written").map(asTier)
  : readJsonl("./data/seed.jsonl").map(asTier);
if (hasMerged) console.log("Using merged dataset (seed + real + wildchat)");

// Deterministic shuffle so runs are comparable.
let s = SEED;
const rand = () => ((s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const shuffle = (a) => a.map((x) => [rand(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);

const train = [...seed];
const test = [];
for (const c of CLASSES) {
  const rows = shuffle(real.filter((r) => r.label === c));
  const nTest = Math.max(1, Math.round(rows.length * HOLDOUT));
  test.push(...rows.slice(0, nTest));
  train.push(...rows.slice(nTest));
}

// Vocabulary from the training set only.
const counts = new Map();
const trainFeats = train.map((r) => [...new Set(featurize(r.prompt))]);
for (const fs of trainFeats) for (const f of fs) counts.set(f, (counts.get(f) ?? 0) + 1);
const vocab = {};
for (const [f, n] of counts) if (n >= MIN_COUNT || f.startsWith("__")) vocab[f] = Object.keys(vocab).length;
const V = Object.keys(vocab).length;

const W = Array.from({ length: V }, () => new Float64Array(CLASSES.length));
const b = new Float64Array(CLASSES.length);
const classWeight = CLASSES.map((c) => train.length / (CLASSES.length * train.filter((r) => r.label === c).length));

const X = trainFeats.map((fs) => fs.map((f) => vocab[f]).filter((i) => i !== undefined));
const Y = train.map((r) => CLASSES.indexOf(r.label));

function forward(idx) {
  const z = Array.from(b);
  for (const i of idx) for (let c = 0; c < z.length; c++) z[c] += W[i][c];
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const sum = e.reduce((a, v) => a + v, 0);
  return e.map((v) => v / sum);
}

for (let epoch = 0; epoch < EPOCHS; epoch++) {
  const order = shuffle([...X.keys()]);
  const lr = LR / (1 + epoch * 0.1);
  for (const n of order) {
    const p = forward(X[n]);
    const w = classWeight[Y[n]];
    for (let c = 0; c < CLASSES.length; c++) {
      const g = (p[c] - (c === Y[n] ? 1 : 0)) * w;
      b[c] -= lr * g;
      for (const i of X[n]) W[i][c] -= lr * (g + L2 * W[i][c]);
    }
  }
}

function predict(prompt) {
  const idx = [...new Set(featurize(prompt))].map((f) => vocab[f]).filter((i) => i !== undefined);
  const p = forward(idx);
  const best = p.indexOf(Math.max(...p));
  return { tier: CLASSES[best], confidence: p[best] };
}

function report(name, rows, fn) {
  let ok = 0;
  const confusion = {};
  for (const r of rows) {
    const got = fn(r.prompt);
    if (got === r.label) ok++;
    confusion[`${r.label}->${got}`] = (confusion[`${r.label}->${got}`] ?? 0) + 1;
  }
  console.log(`${name}: ${ok}/${rows.length} correct (${((100 * ok) / rows.length).toFixed(0)}%)`);
  return confusion;
}

console.log(`train ${train.length} (${seed.length} written + ${train.length - seed.length} real), test ${test.length} real, ${V} features\n`);
report("keyword rules on held-out real prompts", test, (p) => rules({ prompt: p, contextBytes: Buffer.byteLength(p) }).tier);
const conf = report("trained model  on held-out real prompts", test, (p) => predict(p).tier);
report("trained model  on training set        ", train, (p) => predict(p).tier);
console.log("\nheld-out confusion (truth->predicted):", conf);
console.log("\nheld-out detail:");
for (const r of test) {
  const got = predict(r.prompt);
  console.log(`  ${got.tier === r.label ? "ok " : "BAD"} ${r.label.padEnd(8)} -> ${got.tier.padEnd(8)} ${(got.confidence * 100).toFixed(0).padStart(3)}%  ${r.prompt.slice(0, 70).replace(/\n/g, " ")}`);
}

const model = {
  version: 1,
  classes: CLASSES,
  vocab,
  weights: W.map((row) => Array.from(row, (v) => Math.round(v * 1000) / 1000)),
  bias: Array.from(b, (v) => Math.round(v * 1000) / 1000),
};
writeFileSync(new URL("../resources/classifier-model.json", import.meta.url), JSON.stringify(model));
console.log(`\nwrote resources/classifier-model.json (${V} features)`);
