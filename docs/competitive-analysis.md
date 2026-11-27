# Competitive Analysis & Roadmap

What seven open-source model routers (plus one closed service) do, what
they got right, and what we should bring into Claude Router.

---

## Repos reviewed

| Repo | Stars | Language | Approach |
|---|---|---|---|
| [marco-jardim/opencode-model-router](https://github.com/marco-jardim/opencode-model-router) | 163 | TypeScript | Orchestrator-driven routing via injected protocol; optional cost-aware engine with Beta posteriors |
| [vllm-project/semantic-router](https://github.com/vllm-project/semantic-router) | 6.5k | Go + Python | Signal → Projection → Decision → Algorithm pipeline; pluggable decision models |
| [NVIDIA-AI-Blueprints/llm-router](https://github.com/NVIDIA-AI-Blueprints/llm-router) | — | Python | Intent classifier (Qwen 1.7B) or CLIP embedding → MLP; threshold-then-cheapest selection |
| [weave-os/router](https://github.com/weave-os/router) | — | Go + Python sidecar | Embedding → PCA → HMM → XGBoost classifier; Go arm selector |
| [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | 38k | Node/Electron | Rule engine + JS script hooks; optional external classifier |
| [danvega/spring-ai-model-router](https://github.com/danvega/spring-ai-model-router) | 5 | Java/Spring | Zero-shot LLM call picks a tier per request |
| [code100x/openrouter](https://github.com/code100x/openrouter) | — | TS/Elysia | Billing proxy only; caller names the model |
| **openrouter.ai** (service) | — | Closed | Auto Router: prompt difficulty + pricing + cache + sticky sessions |

Note: NVIDIA's llm-router is deprecated in favor of NeMo Switchyard.
vllm-project/semantic-router is under active development (v0.4 "Hermes").

---

## Key ideas worth adopting

### 1. Orchestrator-driven delegation with task taxonomy
**Source:** marco-jardim/opencode-model-router

The most directly comparable project. It's an OpenCode plugin that routes
coding subtasks to Claude Haiku (fast), Sonnet (medium), or Opus (heavy).
The key insight: **the orchestrator model itself does the routing**, guided
by a dense protocol injected into its system prompt. Task patterns in
`tiers.json` map task types to tiers:
- **fast:** search, grep, read, git-info, ls, count
- **medium:** impl-feature, refactor, write-tests, bugfix(≤2), code-review
- **heavy:** arch-design, debug(≥3fail), sec-audit, root-cause-analysis

The optional cost-aware engine goes further: it tracks Beta-posterior
pass/fail rates per (class × agent × model) from verified outcomes, then
computes expected cost per candidate including retry probability. It only
switches to a cheaper model when there's enough observed evidence (priors
alone never move a dispatch).

**What to do:**
- Adopt their **task taxonomy** as additional heuristic signals in our
  classifier. Their fast/medium/heavy task patterns are a battle-tested
  set of coding-specific keywords we can add to our keyword rules.
- Adopt their **per-tier dispatch caps** concept: limit how many tool
  calls a Haiku-routed turn can make before escalating. This prevents
  cheap models from burning tokens on tasks they can't finish.
- Consider their **Beta-posterior learning**: track pass/fail per tier
  from escalation data in our decision log. After enough observations,
  adjust per-tier confidence thresholds automatically. This is the
  "online learning" version of what we're doing with batch training.
- Their **budget modes** (/budget normal|budget|quality|deep) are worth
  having as a user-facing quick setting, mapping to our pinnedFamily or
  threshold adjustments.

### 2. Signal-driven routing
**Source:** vllm-project/semantic-router

Their pipeline decomposes routing into composable stages:
- **Signals** — facts about the request (complexity, domain, PII, jailbreak, language, keywords). Some are heuristic (no model call), some ask a small "decision model."
- **Projections** — combine signals: partitions pick one winner among overlaps, scores weight inputs, mappings turn scores into named bands.
- **Decisions** — boolean logic (AND/OR/NOT) over projections. Priority + strategy when several match.
- **Algorithms** — select a model (static, random, multi_factor) or run several and pick the best (escalate, fusion).

**What to do:** We don't need the full framework, but the **signal**
concept is worth adopting. Right now our classifier is a monolith that
outputs one family. Instead, extract independent signals:
- `complexity` (trivial / standard / complex / expert) — the trained model
- `hasCode` (boolean) — heuristic
- `isCreative` (boolean) — heuristic
- `contextSize` (small / medium / large) — from attachment bytes
- `language` (en / other) — heuristic

Then a simple decision table maps the signal vector to a family. This is
more debuggable, more extensible, and each signal can be tested and
improved independently.

### 2. Threshold-then-cheapest selection
**Source:** NVIDIA llm-router

Their auto-router scores each model, then: (a) keep models whose score
meets a per-model quality threshold, (b) among those, pick the cheapest,
(c) if none qualify, pick the highest raw score as fallback.

This is better than argmax because it encodes a cost preference: when two
models are both "good enough," pick the cheaper one. And the threshold
fallback means you never return nothing.

**What to do:** Our classifier already returns probabilities per family.
Instead of argmax-with-50%-floor, apply per-family thresholds:
- Haiku: 0.40 (low bar — it's the cheapest, prefer it when possible)
- Sonnet: 0.50
- Opus: 0.60 (higher bar — expensive, need more confidence)
- Fable: 0.55

Among families that clear their threshold, pick the cheapest (Haiku <
Sonnet < Opus; Fable is a lateral choice for creative work). If none
clear, fall back to keyword rules as today.

### 3. Classify complexity, not model family
**Source:** weave-os/router, NVIDIA llm-router

Both separate "how hard is this" from "which model." Weave's classifier
outputs difficulty; NVIDIA's MLP outputs per-model scores but selection
is cost-aware. The complexity scale survives model roster changes.

**What to do:** Refactor our classifier to output a difficulty tier
(trivial / standard / complex / expert) instead of haiku/sonnet/opus/fable
directly. A one-line mapping in `router.ts` converts the tier to a family.
The training labels stay the same (we just relabel them as tiers); the
interface improves.

### 4. Dense embeddings instead of bag-of-words
**Source:** weave-os/router (Gemini embeddings), NVIDIA llm-router (CLIP embeddings)

Both use dense vector representations. Weave uses 3072-dim Gemini
embeddings as the majority of their feature vector. NVIDIA uses CLIP
(multimodal — handles images too). Our bag-of-words + bigrams miss
semantic similarity entirely.

**What to do (long-term):** Bundle a small ONNX embedding model
(all-MiniLM-L6-v2, ~23 MB quantized) and run it in-process. Use the
embedding as features alongside the current text features. This is the
single biggest accuracy lever, but adds extension size and load time.

**What to do (short-term):** More labelled data covers more surface area
even without embeddings. Write the WildChat download + auto-label scripts
to get from 356 to ~5 000 examples first.

### 5. Two-tier intent + complexity routing
**Source:** NVIDIA llm-router

Their intent router is a cheap first pass: a small model (Qwen 1.7B)
classifies the prompt into 5 intent buckets (hard_question, chit_chat,
try_again, image_understanding, image_question), and each bucket maps to
a model. The NN auto-router is the expensive second pass for when intent
alone isn't enough.

**What to do:** We can apply the same two-tier idea cheaply. Our keyword
rules are already an "intent" pass (code keywords, creative keywords).
The trained model is the "complexity" pass. Make this explicit:
1. Fast heuristic signals → if high confidence, route immediately
2. Trained model → if above threshold, route by difficulty
3. Fallback → Sonnet (the safest middle ground)

### 6. Ordered fallback chain
**Source:** musistudio/claude-code-router, weave-os/router

Both implement a fallback chain: if the chosen model returns an error
(rate limit, overload, outage), try the next model in an ordered list.
CCR distinguishes Retry (same model) from Fallback (next model) and
honors Retry-After headers with exponential backoff.

**What to do:** We already have escalation (model replies ESCALATE → one
tier up). Add a provider-level fallback: on 429/529/5xx from Anthropic,
retry once on the same model, then try the next provider for the same
family (e.g., Anthropic Sonnet → Bedrock Sonnet → Vertex Sonnet). The
registry already carries all three provider IDs per version.

### 7. Credential pool and key rotation
**Source:** musistudio/claude-code-router

CCR supports multiple API keys per provider and rotates between them.
When one key hits a rate limit, the next key is used automatically.

**What to do:** Add an optional `anthropic.apiKeys` array setting (in
addition to the current single SecretStorage key). Round-robin or
least-recently-rate-limited selection. Low priority — most individual
users have one key — but useful for teams sharing an extension config.

### 8. Session stickiness / escalation floor
**Source:** weave-os/router, openrouter.ai Auto Router

Both pin a conversation to the tier it escalated to, so follow-up turns
don't drop back to Haiku mid-thought. OpenRouter calls this "sticky
sessions."

**What to do:** We already have this — our escalation floor stays for the
rest of the chat and resets on "New chat". Confirmed as the right design.

### 9. Request logging with route reason
**Source:** musistudio/claude-code-router, weave-os/router

Both log the original model, resolved model, route reason, and fallback
attempts per request. CCR exposes this in a UI.

**What to do:** We already have the decision log (JSONL with classifier
scores, reasons, escalations). Add a simple webview panel in VS Code
that shows recent decisions in a table, instead of requiring the user to
open the raw JSONL. Low priority but good UX.

### 10. Subagent-aware routing
**Source:** musistudio/claude-code-router

CCR injects available model descriptions into Claude Code's tool text and
reads back a `<CCR-SUBAGENT-MODEL>` tag, so subagents (Task, Workflow)
can pick a different model than the main agent.

**What to do:** Not applicable yet — we're a VS Code extension, not a
proxy. But if we ever add a proxy mode, this is the pattern to follow for
multi-agent routing.

### 11. Explicit tier descriptions as labelling rubric
**Source:** danvega/spring-ai-model-router

Their ModelTier enum carries a one-line description per tier that the LLM
uses to decide. We can use the same style as labelling instructions when
auto-labelling WildChat prompts.

**What to do:** Write a labelling system prompt with tier descriptions:
- **trivial (→ Haiku):** quick, low-stakes (greetings, one-line facts, formatting, short rewrites)
- **standard (→ Sonnet):** everyday tasks (summaries, explanations, single functions, Q&A)
- **complex (→ Opus):** multi-step reasoning, multi-file code, detailed analysis, debugging
- **expert (→ Fable):** creative/narrative work, long-form writing, roleplay, style-sensitive

Use this rubric in the auto-labelling prompt sent through the Groq proxy.

### 12. Pluggable "recipes" per use case
**Source:** vllm-project/semantic-router

A "recipe" is a named routing policy: it owns its own signals, decisions,
algorithms, cache namespace, and routing state. Different virtual model
names select different recipes, so policies don't leak between use cases.

**What to do:** We already have workspace rules that adjust routing per
project. The recipe concept suggests going further: let users define
named profiles (e.g., "code-review" always uses Opus, "chat" uses auto,
"creative" biases toward Fable) and switch between them. This maps
naturally to our existing settings structure — a profile is just a preset
for `pinnedFamily` + classifier weights. Low priority but elegant.

---

## What NOT to copy

| Idea | Why not |
|---|---|
| Remote LLM call for every routing decision (danvega, NVIDIA intent mode) | Adds latency, cost, and a network dependency per request. Our value prop is "decision never leaves your machine." |
| Orchestrator-as-router (opencode-model-router) | Injecting a routing protocol into the system prompt is clever for a proxy/plugin, but we classify before the model is called, not during. Their approach also burns tokens on the protocol in every message (~4K chars). |
| External embedding API for featurization (weave-os Gemini, NVIDIA CLIP) | Same privacy concern. A local ONNX model is fine; calling an external embedding API is not. |
| Proxy architecture (musistudio, weave-os, semantic-router) | We're an extension, not a proxy. The routing logic lives in-process. If we add proxy mode later, it's a new surface, not a rewrite. |
| Rule engine with header/body conditions (musistudio) | Overkill for a VS Code extension. Our prefix/pin/workspace/classifier chain is simpler and covers the same cases. |
| Full signal/projection/decision framework (semantic-router) | Over-engineered for 4 Claude tiers. Borrow the signal concept; skip the framework. |
| CLIP multimodal embeddings (NVIDIA) | We route text prompts. Image routing is not in scope. |
| Deprecated/experimental codebases as dependencies (NVIDIA → NeMo Switchyard) | NVIDIA's llm-router is already deprecated. Use their ideas, not their code. |

---

## Priority roadmap

| # | Task | Effort | Impact | Source |
|---|---|---|---|---|
| 1 | WildChat download + Groq auto-labelling scripts | 1 day | High — 5k+ examples fixes accuracy | weave-os, NVIDIA (data volume matters) |
| 2 | Add coding task taxonomy to keyword rules | 2 hours | High — immediate accuracy boost for code prompts | opencode-model-router |
| 3 | Extract independent signals (complexity, hasCode, isCreative, contextSize) | 4 hours | High — debuggable, extensible | semantic-router |
| 4 | Threshold-then-cheapest selection (replace argmax) | 2 hours | Medium — cost-aware routing | NVIDIA |
| 5 | Refactor classifier to output difficulty tiers | 2 hours | Medium — cleaner abstraction, roster-proof | weave-os |
| 6 | Provider-level fallback on 429/5xx | 4 hours | High — reliability in production | musistudio, weave-os |
| 7 | Labelling rubric in auto-label prompt | 30 min | Medium — tighter labels | danvega |
| 8 | Budget modes (/budget normal\|budget\|quality\|deep) | 2 hours | Medium — quick UX for cost control | opencode-model-router |
| 9 | Per-tier dispatch caps (escalate if too many tool calls) | 3 hours | Medium — prevents cheap-model token waste | opencode-model-router |
| 10 | Decision log viewer webview | 4 hours | Low — UX polish | musistudio |
| 11 | Local ONNX embedding model | 2 days | Very high — semantic features | weave-os, NVIDIA |
| 12 | Beta-posterior threshold learning from decision log | 1 day | Medium — auto-tuning over time | opencode-model-router |
| 13 | Key rotation / credential pool | 2 hours | Low — team use only | musistudio |
| 14 | Named routing profiles / recipes | 4 hours | Low — power-user feature | semantic-router |

Items 1–7 are the immediate next steps. Item 11 is the biggest accuracy
lever but the heaviest lift.

---

## Architecture comparison

```
danvega (simplest)              NVIDIA (two-tier)
prompt → LLM call → tier       prompt → intent classifier → model
                                     OR → CLIP embed → MLP → threshold → cheapest

weave-os (production)           semantic-router (framework)
prompt → embed → PCA → HMM     prompt → signals (heuristic + decision model)
      → XGBoost → probs              → projections (combine signals)
      → Go arm selector               → decisions (boolean logic)
      → fallback walk                  → algorithms (select or execute)

opencode-model-router           musistudio (rule engine)
prompt → injected protocol      prompt → ordered rules
      → orchestrator decides          → JS script hooks
      → task taxonomy tiers           → fallback chain
      → Beta-posterior learning

Claude Router (ours, current)   Claude Router (target)
prompt → prefix → pin           prompt → heuristic signals (fast, free)
      → workspace rules               → task taxonomy (coding keywords)
      → trained model (≥50%)           → trained model → difficulty tier
      → keyword fallback               → per-tier thresholds → cheapest
                                       → provider fallback chain
                                       → Beta-posterior threshold tuning
```
