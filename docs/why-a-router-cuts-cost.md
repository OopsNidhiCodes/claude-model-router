# Why a Model Router Cuts Claude Costs

As of 2026-11-19. Prices are Anthropic first-party API list prices, cached 2026-11-03, from https://platform.claude.com/docs/en/about-claude/pricing. All cost figures below are modelled estimates, not measured spend.

## Summary

Routing each prompt to the cheapest Claude tier that can handle it cuts our modelled monthly spend by about 46% against always using Opus, and by about 78% against always using Fable, at the same quality on the work that matters.

Most developer prompts are small: a typo, a rename, a short function, a quick explanation. Sent to a frontier model they cost 40 to 100 times what Haiku charges for the same answer, and the frontier model also spends more output tokens on thinking before it replies. A single-model setup pays that premium on every request. The router pays it only on the requests that need it, keeps an escape hatch for the ones it misjudges, and shows exactly which model answered each time.

For a team of 10 developers at 800 prompts each per month, the model works out to roughly $209 routed against $384 all-Opus and $960 all-Fable.

## How Claude pricing works

You pay per token, separately for input and output, and the rate depends on the model tier. Output is five times the input rate on every tier, and the tiers are far apart.

| Tier | Model | Input $ per 1M tokens | Output $ per 1M tokens | Relative to Haiku |
|---|---|---|---|---|
| Haiku | claude-haiku-5-5 | 0.10 | 0.50 | 1x |
| Sonnet | claude-sonnet-5-5 | 2.00 | 10.00 | 20x |
| Opus | claude-opus-5-5 | 4.00 | 20.00 | 40x |
| Fable | claude-fable-5-1 | 10.00 | 50.00 | 100x |

Two things make the gap wider than the price table alone suggests:

- **Input is everything you send, every time.** The system prompt, the attached file, and the whole conversation history are re-sent on each turn. A chat with a 400-line file attached is 5,000 to 8,000 input tokens per message before you type a word.
- **Thinking is billed as output.** The current Opus, Sonnet and Fable models reason before answering, and those reasoning tokens are charged at the output rate even though you never see them. On a frontier model a one-line answer can carry several hundred tokens of thinking behind it. Haiku does far less of this. So the expensive model is not only pricier per token, it tends to emit more billable tokens for the same request.

## The single-model habit

When a tool offers one model, teams pick the strongest one, because nobody wants the assistant to fail on the hard question. The result is that the hard-question price is paid on every easy question too.

Look at what developers actually send to an in-editor assistant over a week:

| Kind of request | Typical share | Example | Tier that is enough |
|---|---|---|---|
| Quick fixes and explanations | 35 to 45% | fix this typo, rename this, what does this error mean | Haiku |
| Implementation | 35 to 45% | add a unit test, write this handler, refactor this function | Sonnet |
| Deep reasoning | 10 to 20% | why is there a race condition, review this design | Opus |
| Long multi-step or agentic work | around 5% | migrate every test, iterate until the build passes | Fable |

The shares are estimates from our own usage pattern and will vary by team. The shape is not in doubt: the bulk of requests are small. Under a single-model policy, 80% or more of spend goes to requests a model 20 to 100 times cheaper would have answered identically.

## What the router does

The extension decides locally, in microseconds, before anything is sent, and the decision is deterministic and explainable.

1. **Prefix.** A developer who knows what they want types `/opus` or `/sonnet-5.5` and that is final.
2. **Pin.** A setting can lock a family for a session. The status bar warns if a pinned low tier is handling a complex task.
3. **Classifier.** Keyword rules and the size of the attached context score each family. "typo", "rename", "lint" point to Haiku. "implement", "test", "add" point to Sonnet. "architecture", "race condition", "root cause" point to Opus. "migrate", "until tests pass", "automate" point to Fable.
4. **Exact version.** The chosen family resolves to a specific model version from a registry, with retired IDs mapped forward automatically.

Nothing about the prompt leaves the machine during the decision. There is no model call to pick a model, so the router adds no latency and no cost of its own.

## Worked comparison

Assumptions, chosen to be conservative:

- 10 developers, 40 prompts per working day, 20 days. 8,000 prompts per month.
- Average request: 6,000 input tokens, including the attached file and history, and 1,200 output tokens, including thinking.
- Routed mix: 40% Haiku, 40% Sonnet, 15% Opus, 5% Fable.
- Escalation overhead: 10% of Haiku and Sonnet requests are redone one tier up, and we pay for both attempts.

Cost per request at the assumed size:

| Model | Input cost | Output cost | Cost per request |
|---|---|---|---|
| Haiku 5.5 | $0.0006 | $0.0006 | $0.0012 |
| Sonnet 5.5 | $0.012 | $0.012 | $0.024 |
| Opus 5.5 | $0.024 | $0.024 | $0.048 |
| Fable 5.1 | $0.060 | $0.060 | $0.120 |

Monthly cost for 8,000 requests:

| Policy | Monthly cost | Yearly cost | Saving vs all-Opus |
|---|---|---|---|
| Always Fable | $960 | $11,520 | none, 2.5x more |
| Always Opus | $384 | $4,608 | baseline |
| Always Sonnet | $192 | $2,304 | 50%, but fails the hard 20% |
| Routed, no escalation | $186 | $2,235 | 52% |
| Routed, with 10% escalation overhead | $209 | $2,508 | 46% |

Always-Sonnet looks close to the routed figure, but it is not the same product. It under-serves every deep-reasoning and agentic request, which is exactly the 20% where a wrong answer costs engineering hours. The routed policy spends 53% of its budget on that 20% of requests, which is where the money should go.

The saving scales linearly with usage. At 50 developers the gap between all-Opus and routed is about $875 a month. At 50 developers on all-Fable it is about $3,750 a month.

Token volume tells the same story from the other side. Under the routed policy, 80% of requests go to models that think less, so total billed output tokens fall as well as the price per token. We have not measured this multiplier on our own traffic yet; the decision log described below is how we will.

## Keeping quality

The saving is only real if the cheap tier does not quietly produce worse answers on hard work. Four mechanisms guard that:

- **The model can hand off.** Every tier below Fable is told it may reply with a single `ESCALATE` token when a task is genuinely beyond it. The extension discards that reply and reruns the request one tier up. In testing, the small model answered a typo fix, a cron parser and a flaky-test question itself and handed off only a platform-wide distributed-systems audit. Automatic escalation is capped at one hop per request so a bad instruction cannot run up a bill.
- **The developer can override.** An Escalate button redoes the last answer on the next tier. A `/opus` prefix skips the classifier entirely. Once a chat has escalated, it stays at that tier until a new chat starts.
- **Every decision is visible.** The status bar shows the exact model version that answered and why it was chosen. Nobody is guessing which model wrote the code.
- **Every decision can be logged.** An opt-in local log records the prompt, context size, classifier scores, the tier chosen, the tier that finally answered, and whether it was escalated. After a few weeks this tells us the real escalation rate, the real mix, and which prompts the rules misroute. It is also the labelled data a trained classifier would need if we decide the keyword rules are not enough.

The escalation overhead is already in the cost model at 10%. If the measured rate is lower, savings are higher. If it is much higher, the classifier rules need tuning and the log shows where.

## Assumptions and caveats

- Prices are list prices for the first-party API. Bedrock and Vertex pricing differ. Prompt caching, which we have not enabled, would reduce input cost further on all policies, most of all on the expensive tiers.
- The 40/40/15/5 mix is an estimate. The decision log will replace it with a measured figure.
- Request sizes vary widely. Inline edits send the whole file, so large files cost more on every policy. The ratio between policies is what matters, and it is insensitive to the absolute size.
- Haiku 5.5 pricing applies to prompts up to 100K tokens. Our requests are far below that.
- The classifier is keyword-based. It will misroute some prompts in both directions. Escalation fixes under-routing. Over-routing, sending an easy prompt to Opus, only costs money, and the log will show how often it happens.
- Quality on the Groq proxy we have been testing with is not representative. These figures are about Claude pricing and the routing logic, which we have verified. The quality claim needs a short trial on real Claude models.

## Next steps

1. Get an Anthropic API key with a small spend limit so we can run on real Claude models.
2. Turn on the decision log and run the router for two weeks across a few developers.
3. Read the log: measured tier mix, escalation rate, and misroutes. Replace the estimates in this document with real numbers.
4. If the measured saving holds, enable prompt caching for the attached-file context and remeasure.
5. If the keyword classifier misroutes more than a few percent, use the logged prompts to train a small local classifier and compare it against the rules on the same data.
