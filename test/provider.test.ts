import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripFences } from "../src/core/text";
import {
  assistantTurn,
  FallbackCandidate,
  fallbackServedBy,
  Message,
  NetworkProvider,
  SdkProvider,
  streamWithFallback,
} from "../src/providers/provider";

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

function plainMessage(model: string, text = ""): Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content: text ? [{ type: "text", text }] : [],
  } as unknown as Message;
}

/** A NetworkProvider whose single call is scripted: stream some text, then resolve or reject. */
function scripted(name: FallbackCandidate["provider"], run: (onText: (d: string) => void) => Promise<Message>): NetworkProvider {
  return { name, stream: (_req, onText) => run(onText) };
}

function candidate(provider: FallbackCandidate["provider"], client: NetworkProvider, model = "m"): FallbackCandidate {
  return { provider, client, model };
}

const baseReq = { system: "", messages: [] as Anthropic.Beta.Messages.BetaMessageParam[], maxTokens: 64000, serverFallback: false };

describe("streamWithFallback", () => {
  it("returns the primary's message with no fallback reported when it succeeds", async () => {
    const primary = candidate("anthropic", scripted("anthropic", async () => plainMessage("claude-sonnet-5-5", "hi")));
    const result = await streamWithFallback([primary], baseReq, () => undefined);
    assert.equal(result.servedByProvider, undefined);
    assert.equal(result.message.model, "claude-sonnet-5-5");
  });

  it("falls back to the next provider on a retryable error", async () => {
    const primary = candidate(
      "anthropic",
      scripted("anthropic", async () => {
        throw new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers(), undefined);
      }),
    );
    const fallback = candidate("bedrock", scripted("bedrock", async () => plainMessage("anthropic.claude-sonnet-5-5", "hi")), "anthropic.claude-sonnet-5-5");
    const result = await streamWithFallback([primary, fallback], baseReq, () => undefined);
    assert.equal(result.servedByProvider, "bedrock");
    assert.equal(result.servedByModel, "anthropic.claude-sonnet-5-5");
  });

  it("walks past a fallback that also fails, to the one after it", async () => {
    const primary = candidate("anthropic", scripted("anthropic", async () => {
      throw new Anthropic.InternalServerError(529, undefined, "overloaded", new Headers(), undefined);
    }));
    const bedrock = candidate("bedrock", scripted("bedrock", async () => {
      throw new Error("no AWS credentials configured");
    }));
    const vertex = candidate("vertex", scripted("vertex", async () => plainMessage("claude-sonnet-5-5", "hi")));
    const result = await streamWithFallback([primary, bedrock, vertex], baseReq, () => undefined);
    assert.equal(result.servedByProvider, "vertex");
  });

  it("does not fall back on a non-retryable error", async () => {
    const primary = candidate("anthropic", scripted("anthropic", async () => {
      throw new Anthropic.AuthenticationError(401, undefined, "bad key", new Headers(), undefined);
    }));
    const fallback = candidate("bedrock", scripted("bedrock", async () => plainMessage("m", "should not be called")));
    await assert.rejects(
      streamWithFallback([primary, fallback], baseReq, () => undefined),
      Anthropic.AuthenticationError,
    );
  });

  it("surfaces the primary's error, not a fallback's, when every candidate fails", async () => {
    const primaryErr = new Anthropic.RateLimitError(429, undefined, "primary rate limited", new Headers(), undefined);
    const primary = candidate("anthropic", scripted("anthropic", async () => { throw primaryErr; }));
    const fallback = candidate("bedrock", scripted("bedrock", async () => {
      throw new Error("obscure AWS credential resolution failure");
    }));
    await assert.rejects(streamWithFallback([primary, fallback], baseReq, () => undefined), (err: unknown) => err === primaryErr);
  });

  it("never falls back once any text has reached the caller", async () => {
    const primary = candidate(
      "anthropic",
      scripted("anthropic", async (onText) => {
        onText("partial reply");
        throw new Anthropic.InternalServerError(500, undefined, "dropped mid-stream", new Headers(), undefined);
      }),
    );
    const fallback = candidate("bedrock", scripted("bedrock", async () => plainMessage("m", "should not be called")));
    const seen: string[] = [];
    await assert.rejects(streamWithFallback([primary, fallback], baseReq, (d) => seen.push(d)));
    assert.deepEqual(seen, ["partial reply"]);
  });

  it("stops at the fallback that streamed partial text, not the next one", async () => {
    const primary = candidate("anthropic", scripted("anthropic", async () => {
      throw new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers(), undefined);
    }));
    const fallbackErr = new Error("bedrock dropped mid-stream");
    const bedrock = candidate("bedrock", scripted("bedrock", async (onText) => {
      onText("partial from bedrock");
      throw fallbackErr;
    }));
    const vertex = candidate("vertex", scripted("vertex", async () => plainMessage("m", "should not be called")));
    const seen: string[] = [];
    await assert.rejects(
      streamWithFallback([primary, bedrock, vertex], baseReq, (d) => seen.push(d)),
      (err: unknown) => err === fallbackErr,
    );
    assert.deepEqual(seen, ["partial from bedrock"]);
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
