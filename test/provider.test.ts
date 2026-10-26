import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripFences } from "../src/core/text";
import { assistantTurn, fallbackServedBy, Message, SdkProvider } from "../src/providers/provider";

function sse(events: object[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function streamBody(model: string, text: string) {
  return sse([
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]);
}

/** A client whose fetch records the request and replies with a canned stream. */
function stubClient(model: string, text: string) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const client = new Anthropic({
    apiKey: "test",
    maxRetries: 0,
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(streamBody(model, text), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { client, calls };
}

describe("SdkProvider", () => {
  it("streams text and sends server-side fallbacks when supported", async () => {
    const { client, calls } = stubClient("claude-opus-5-5", "hello");
    const provider = new SdkProvider("anthropic", client, true);
    const deltas: string[] = [];
    const message = await provider.stream(
      { model: "claude-opus-5-5", system: "sys", messages: [{ role: "user", content: "hi" }], maxTokens: 64000, serverFallback: true },
      (d) => deltas.push(d),
    );
    assert.deepEqual(deltas, ["hello"]);
    assert.equal(message.content[0].type === "text" && message.content[0].text, "hello");

    const { body, headers } = calls[0];
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.max_tokens, 64000);
    assert.equal(body.stream, true);
    assert.equal(body.fallbacks, "default");
    assert.equal(body.thinking, undefined);
    assert.equal(body.temperature, undefined);
    assert.match(headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
  });

  it("omits fallbacks for providers or models without them", async () => {
    const { client, calls } = stubClient("claude-haiku-5-5", "x");
    await new SdkProvider("bedrock", client, false).stream(
      { model: "claude-haiku-5-5", system: "", messages: [{ role: "user", content: "hi" }], maxTokens: 1024, serverFallback: true },
      () => undefined,
    );
    assert.equal(calls[0].body.fallbacks, undefined);
    assert.equal(calls[0].headers.get("anthropic-beta"), null);
  });
});

describe("message helpers", () => {
  const base = { id: "m", type: "message", role: "assistant", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };

  it("drops thinking before the last fallback boundary", () => {
    const message = {
      ...base,
      model: "claude-opus-4-8",
      content: [
        { type: "thinking", thinking: "", signature: "a" },
        { type: "text", text: "partial" },
        { type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-opus-4-8" } },
        { type: "thinking", thinking: "", signature: "b" },
        { type: "text", text: "rest" },
      ],
    } as unknown as Message;
    const types = (assistantTurn(message).content as { type: string }[]).map((b) => b.type);
    assert.deepEqual(types, ["text", "fallback", "thinking", "text"]);
    assert.equal(fallbackServedBy(message, "claude-fable-5-1"), "claude-opus-4-8");
  });

  it("reports no fallback for a normal reply", () => {
    const message = { ...base, model: "claude-sonnet-5-5", content: [{ type: "text", text: "ok" }] } as unknown as Message;
    assert.equal(fallbackServedBy(message, "claude-sonnet-5-5"), undefined);
  });

  it("strips one wrapping code fence only", () => {
    assert.equal(stripFences("```ts\nconst a = 1;\n```"), "const a = 1;");
    assert.equal(stripFences("const a = 1;"), "const a = 1;");
    assert.equal(stripFences("text ```x``` more"), "text ```x``` more");
  });
});
