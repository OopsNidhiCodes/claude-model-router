import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { ProviderName } from "../core/types";

export type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type Message = Anthropic.Beta.Messages.BetaMessage;

export interface ChatRequest {
  model: string;
  system: string;
  messages: MessageParam[];
  maxTokens: number;
  /** Opt into server-side refusal fallbacks (Claude API only). */
  serverFallback: boolean;
  signal?: AbortSignal;
}

export interface ProviderOptions {
  anthropicApiKey?: string;
  /** Overrides the Claude API host, e.g. a local proxy. */
  anthropicBaseUrl?: string;
  bedrockRegion?: string;
  vertexProjectId?: string;
  vertexRegion?: string;
}

/** Strategy interface: every provider streams a Messages request the same way. */
export interface NetworkProvider {
  readonly name: ProviderName;
  stream(req: ChatRequest, onText: (delta: string) => void): Promise<Message>;
}

/**
 * True for errors worth trying a different provider over: rate limits and
 * server-side overload/errors. Each SDK client already retries these a couple
 * of times internally (with its own backoff, honoring Retry-After) before
 * raising, so reaching here means that was exhausted. Anything else (auth,
 * bad request, a genuine 404) means the request itself is wrong and another
 * provider would fail the same way, so it is surfaced immediately instead.
 */
export function isRetryableError(err: unknown): boolean {
  return err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError;
}

export interface FallbackCandidate {
  provider: ProviderName;
  client: NetworkProvider;
  /** The provider-specific model string for this candidate. */
  model: string;
}

export interface FallbackResult {
  message: Message;
  /** Set only when a provider other than the first candidate answered. */
  servedByProvider?: ProviderName;
  servedByModel?: string;
}

/** How long a fallback provider gets to answer before it's skipped as unreachable or unconfigured. */
const FALLBACK_TIMEOUT_MS = 8000;

/**
 * Streams the first candidate; on a retryable error with nothing streamed yet,
 * walks the rest of the list trying the same request on each in turn. A
 * fallback candidate that is slow to fail (e.g. Bedrock resolving AWS
 * credentials with nothing configured) is bounded so it cannot stall the UI.
 *
 * Once any text has reached the caller, fallback stops: retrying would either
 * duplicate what the user already saw or silently splice two replies together.
 * If every candidate fails, the first candidate's error is what's thrown,
 * since it's the one actually worth explaining — a Bedrock credential error
 * from an unconfigured fallback is not useful to an Anthropic-only user.
 */
export async function streamWithFallback(
  candidates: readonly FallbackCandidate[],
  req: Omit<ChatRequest, "model">,
  onText: (delta: string) => void,
): Promise<FallbackResult> {
  let streamed = false;
  const wrappedOnText = (delta: string) => {
    streamed = true;
    onText(delta);
  };

  const [primary, ...rest] = candidates;
  try {
    const message = await primary.client.stream({ ...req, model: primary.model }, wrappedOnText);
    return { message };
  } catch (primaryErr) {
    if (streamed || rest.length === 0 || !isRetryableError(primaryErr)) throw primaryErr;

    for (const candidate of rest) {
      const signal = combineSignals(req.signal, AbortSignal.timeout(FALLBACK_TIMEOUT_MS));
      try {
        const message = await candidate.client.stream({ ...req, model: candidate.model, signal }, wrappedOnText);
        return { message, servedByProvider: candidate.provider, servedByModel: candidate.model };
      } catch (fallbackErr) {
        if (streamed) throw fallbackErr;
        // Try the next candidate; the original error is still what gets surfaced if they all fail.
      }
    }
    throw primaryErr;
  }
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  return a ? AbortSignal.any([a, b]) : b;
}

// The Mantle and Vertex clients expose the same beta.messages surface as the first-party client.
type MessagesClient = { beta: { messages: Pick<Anthropic["beta"]["messages"], "stream"> } };

export class SdkProvider implements NetworkProvider {
  constructor(
    readonly name: ProviderName,
    private readonly client: MessagesClient,
    private readonly supportsServerFallback: boolean,
  ) {}

  async stream(req: ChatRequest, onText: (delta: string) => void): Promise<Message> {
    const fallback = req.serverFallback && this.supportsServerFallback;
    const stream = this.client.beta.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages,
        ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal: req.signal },
    );
    stream.on("text", onText);
    return stream.finalMessage();
  }
}

export function createProvider(name: ProviderName, opts: ProviderOptions): NetworkProvider {
  switch (name) {
    case "anthropic":
      // Without a stored key the SDK falls back to ANTHROPIC_API_KEY / `ant auth login` credentials.
      return new SdkProvider(
        name,
        new Anthropic({
          ...(opts.anthropicApiKey ? { apiKey: opts.anthropicApiKey } : {}),
          ...(opts.anthropicBaseUrl ? { baseURL: opts.anthropicBaseUrl } : {}),
        }),
        true,
      );
    case "bedrock":
      return new SdkProvider(name, new AnthropicBedrockMantle({ awsRegion: opts.bedrockRegion || undefined }), false);
    case "vertex":
      return new SdkProvider(
        name,
        new AnthropicVertex({ projectId: opts.vertexProjectId || undefined, region: opts.vertexRegion || "global" }),
        false,
      );
  }
}

/** Describes an SDK error for the user, most specific class first. */
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIUserAbortError) return "Request cancelled.";
  if (err instanceof Anthropic.AuthenticationError) return "Authentication failed. Check your credentials (Claude Router: Set Anthropic API Key).";
  if (err instanceof Anthropic.NotFoundError) return `Model not found: ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return "Rate limited. Try again shortly.";
  if (err instanceof Anthropic.BadRequestError) return `Bad request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return `Connection error: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Prepares an assistant turn for history. After a mid-output fallback, thinking
 * blocks emitted before the last fallback boundary must not be echoed back.
 */
export function assistantTurn(message: Message): MessageParam {
  const lastFallback = message.content.map((b) => b.type).lastIndexOf("fallback");
  const content = message.content.filter(
    (b, i) => i > lastFallback || (b.type !== "thinking" && b.type !== "redacted_thinking"),
  );
  return { role: "assistant", content };
}

/** The model that actually produced the message, when a fallback switched it. */
export function fallbackServedBy(message: Message, requested: string): string | undefined {
  const switched = message.content.some((b) => b.type === "fallback") || (message.usage.iterations ?? []).some((i) => i.type === "fallback_message");
  return switched && message.model !== requested ? message.model : undefined;
}

export function messageText(message: Message): string {
  return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}
