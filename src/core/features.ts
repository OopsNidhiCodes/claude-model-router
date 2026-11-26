import { Family } from "./types";

/**
 * Turns a prompt into sparse text features for the trained classifier.
 * Shared by training (ml/train.mjs), the VS Code extension and the web extension,
 * so all three see exactly the same features.
 */
export function featurize(prompt: string): string[] {
  const text = prompt.toLowerCase();
  const words = text.replace(/[^a-z0-9#+./_-]+/g, " ").trim().split(/\s+/).filter((w) => w.length > 0 && w.length < 30);
  const feats: string[] = [];

  for (const w of words) feats.push(w);
  for (let i = 0; i + 1 < words.length; i++) feats.push(`${words[i]}_${words[i + 1]}`);

  // Shape of the prompt, independent of vocabulary.
  const n = words.length;
  feats.push(n <= 4 ? "__len:xs" : n <= 12 ? "__len:s" : n <= 40 ? "__len:m" : n <= 120 ? "__len:l" : "__len:xl");
  if (text.includes("?")) feats.push("__question");
  if (/\n/.test(prompt)) feats.push("__multiline");
  if (/pasted_content|\[image #\d+\]|image attached/.test(text)) feats.push("__attachment");
  if (/[{}();=<>]|```|\b(const|def|function|import|class)\b/.test(text)) feats.push("__codey");
  if (/https?:\/\//.test(text)) feats.push("__url");
  if (/\d/.test(text)) feats.push("__digits");
  return feats;
}

/** Weights for a multinomial logistic regression over `featurize` output. */
export interface ClassifierModel {
  version: 1;
  classes: Family[];
  /** feature -> row index into weights */
  vocab: Record<string, number>;
  /** weights[featureIndex][classIndex] */
  weights: number[][];
  bias: number[];
}

export interface Prediction {
  family: Family;
  probs: Record<Family, number>;
  confidence: number;
}

export function predict(model: ClassifierModel, prompt: string): Prediction {
  const logits = [...model.bias];
  // Binary presence, so a repeated word doesn't dominate.
  for (const f of new Set(featurize(prompt))) {
    const idx = model.vocab[f];
    if (idx === undefined) continue;
    const row = model.weights[idx];
    for (let c = 0; c < logits.length; c++) logits[c] += row[c];
  }
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = {} as Record<Family, number>;
  let best = 0;
  model.classes.forEach((c, i) => {
    probs[c] = exps[i] / sum;
    if (exps[i] > exps[best]) best = i;
  });
  return { family: model.classes[best], probs, confidence: exps[best] / sum };
}
