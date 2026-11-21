# Claude Router

A VS Code extension that routes each prompt to the right Claude model family
(Haiku, Sonnet, Opus or Fable) using a local, deterministic classifier, then
resolves that family to an exact model version before sending the request.

The decision never leaves your machine. Only the final chat request goes to a
provider: the Claude API, Amazon Bedrock or Google Vertex AI.

## How a request is routed

The chain is evaluated top down in `src/core/router.ts`. The first rule that
applies wins.

1. **Prompt prefix.** `/haiku`, `/sonnet`, `/opus`, `/fable`, or an exact
   version such as `/sonnet-5.5`. An unknown version like `/sonnet-9` aborts the
   request. Other slashes (`/usr/bin/foo`) are left alone.
2. **Settings pin.** `claudeRouter.pinnedFamily` forces one family. The status
   bar warns when the classifier would have picked a higher tier.
3. **Workspace rules.** If the workspace declares modern toolchains
   (`package.json`, `tsconfig.json`, `pyproject.toml`, `go.mod`), pinned
   legacy-generation versions are upgraded within the same family.
4. **Local classifier.** Keyword rules plus context size pick a family.
   `src/core/classifier.ts` has the rules.

Each family is then resolved to a concrete model through the per-family
channel setting: latest, pinned snapshot, or a custom model ID. The registry
in `resources/models-registry.json` is the source of truth and can be
replaced via `claudeRouter.registryPath` without a new extension release.

## Project layout

| Path | Purpose |
|---|---|
| `src/core/` | Pure TypeScript, no VS Code imports. Routing, classifier, registry, versions. |
| `src/providers/provider.ts` | One streaming interface over the Anthropic, Bedrock and Vertex SDKs. |
| `src/vscode/` | Chat webview, inline edit command, status bar, settings, workspace scanner. |
| `test/` | Node test runner suites for the core and provider layers. |
| `resources/models-registry.json` | Model families, versions, provider IDs, retired IDs. |

## Commands

Open the Command Palette and type "Claude Router":

- **Open Chat** opens the chat panel. The active selection or file is attached by default.
- **Edit Selection** rewrites the selected code in place. Also in the editor context menu.
- **Pin Model Family** pins every request to one family. Also by clicking the status bar item.
- **Set / Clear Anthropic API Key** stores the key in VS Code SecretStorage.
- **Rescan Workspace Constraints** re-reads the workspace declaration files.
- **Open / Clear Decision Log** views or empties the local routing log.

## Development

```bash
npm install
npm test        # compile, then run the unit tests (no VS Code or API key needed)
```

To run the extension, open this folder in VS Code and press F5. A second
window opens with the extension loaded. Set breakpoints in the `.ts` files;
source maps are configured.

## Testing without an Anthropic API key

You can exercise the whole extension, including the real network path, by
pointing it at a local [LiteLLM](https://github.com/BerriAI/litellm) proxy
that forwards to [Groq](https://console.groq.com/keys), whose free tier is
enough for routing tests. The proxy accepts Anthropic-format requests, so the
extension needs no code changes.

`litellm.yaml` maps the Claude registry IDs to Groq's GPT-OSS models. The
status bar still shows the Claude tier the router chose, which is the part
under test; the reply comes from the mapped Groq model.

One-time setup:

```bash
python3 -m venv .litellm-venv
.litellm-venv/bin/pip install 'litellm[proxy]'
```

Each session:

1. Start the proxy in a terminal and leave it running. The Groq key stays in
   your shell and is never written to a file.

   ```bash
   GROQ_API_KEY=gsk_... scripts/start-proxy.sh
   ```

2. In VS Code settings, set `claudeRouter.anthropic.baseUrl` to
   `http://localhost:4000`.
3. Run **Claude Router: Set Anthropic API Key** and enter `sk-local-proxy`.
   This is the proxy's local master key from `litellm.yaml`, not a real secret.
4. Press F5 and open the chat.

Groq retires model names from time to time. If a request fails with
"model not found", list the models your key can reach and update
`litellm.yaml`:

```bash
curl -s https://api.groq.com/openai/v1/models \
  -H "Authorization: Bearer $GROQ_API_KEY" | python3 -c 'import json,sys; [print(m["id"]) for m in json.load(sys.stdin)["data"]]'
```

The `groq/*` passthrough entry in `litellm.yaml` also lets you call any Groq
model by name from the extension's Custom Model ID channel.

## Escalation

A task can look easy and turn out hard. Two escape hatches re-run a turn one
tier up (Haiku, Sonnet, Opus, Fable):

- **The model asks.** Every tier except the top is told it may reply with the
  single word `ESCALATE` when it genuinely cannot do the task. The extension
  discards that reply and retries on the next tier, up to
  `claudeRouter.escalation.maxAuto` times per request (default 1; 0 disables).
- **You ask.** The **Escalate** button in the chat redoes the last answer on
  the next tier.

Once a chat has escalated, that tier becomes the floor for the rest of the
conversation. "New chat" resets it. A `/prefix` still overrides the floor.

## Decision log

Off by default. Set `claudeRouter.decisionLog.enabled` to record every routed
turn as one JSON line in `decisions.jsonl` inside the extension's storage
folder. **Claude Router: Open Decision Log** opens it; **Clear Decision Log**
empties it. Nothing is ever sent anywhere.

Each line holds the prompt (unless `decisionLog.includePrompt` is off), prompt
and context sizes, classifier scores and reasons, the first decision and its
source, what finally answered, any escalations and who triggered them, and the
stop reason. Attached file content is never logged, only its size.

The log is how you check the classifier against real use and, over time, the
labelled data a trained classifier would need: every escalation says the first
tier was too low, every non-escalated reply says it was probably fine.

## Settings

All settings live under `claudeRouter.*`. The most useful ones:

| Setting | Meaning |
|---|---|
| `provider` | `anthropic`, `bedrock` or `vertex`. |
| `pinnedFamily` | `auto` or a family name. |
| `releaseChannel` | `stable` or `experimental`. |
| `<family>.channel` | `latest`, `snapshot` or `custom` per family. |
| `<family>.snapshot` / `<family>.customModelId` | The version or raw ID for those channels. |
| `anthropic.baseUrl` | Alternate Claude API host, such as a local proxy. |
| `registryPath` | Path to a replacement `models-registry.json`. |
| `maxTokens` | `max_tokens` for every request. |
| `escalation.maxAuto` | Model-initiated escalations allowed per request. |
| `decisionLog.enabled` / `decisionLog.includePrompt` | Local routing log and whether it keeps prompt text. |
