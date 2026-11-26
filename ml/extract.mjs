// Pulls the user's prompts out of the Claude session exports in data/*.md,
// drops commands and duplicates, attaches labels from ml/data/real-labels.json,
// and writes ml/data/real.jsonl. Prompts without a label are written with null
// so they can be labelled by hand.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const key = (p) => createHash("sha1").update(p).digest("hex").slice(0, 10);
const labels = JSON.parse(readFileSync(new URL("./data/real-labels.json", import.meta.url), "utf8"));
const seen = new Set();
const rows = [];
for (const file of readdirSync("data").filter((f) => f.endsWith(".md")).sort()) {
  const text = readFileSync(`data/${file}`, "utf8");
  for (const m of text.matchAll(/^### Prompt \d+ · [^\n]*\n\n((?:> .*\n?)+)/gm)) {
    const prompt = m[1].split("\n").map((l) => l.replace(/^> ?/, "")).join("\n").trim();
    if (prompt.startsWith("/") || prompt.length < 3 || seen.has(prompt)) continue;
    seen.add(prompt);
    rows.push({ id: key(prompt), prompt, label: labels[key(prompt)] ?? null, source: "session-export" });
  }
}
writeFileSync(new URL("./data/real.jsonl", import.meta.url), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const unlabelled = rows.filter((r) => !r.label);
console.log(`${rows.length} prompts, ${unlabelled.length} without a label`);
for (const r of unlabelled) console.log(`  ${r.id}  ${r.prompt.slice(0, 80).replace(/\n/g, " | ")}`);
