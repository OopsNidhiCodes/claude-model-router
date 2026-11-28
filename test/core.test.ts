import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { classify } from "../src/core/classifier";
import { buildEntry, parseDecisionLog } from "../src/core/decisionLog";
import { ESCALATE_TOKEN, isEscalationRequest, nextFamily, systemPromptFor } from "../src/core/escalation";
import { parsePrefix } from "../src/core/prefix";
import { ModelRegistry, RegistryError, validateRegistry } from "../src/core/registry";
import { LEGACY_MAPPED_WARNING, route, RoutingError } from "../src/core/router";
import { Family, FAMILIES, FAMILY_TO_TIER, RouterSettings, TIER_TO_FAMILY, TIERS } from "../src/core/types";
import { evaluateWorkspace } from "../src/core/workspaceConstraints";

const root = join(__dirname, "..", "..");
const rawRegistry = JSON.parse(readFileSync(join(root, "resources", "models-registry.json"), "utf8"));
const registry = new ModelRegistry(validateRegistry(structuredClone(rawRegistry)));

function settings(overrides: Partial<RouterSettings> = {}): RouterSettings {
  const families = Object.fromEntries(FAMILIES.map((f) => [f, { channel: "latest" }])) as RouterSettings["families"];
  return { pinnedFamily: "auto", releaseChannel: "stable", provider: "anthropic", families, budgetMode: "normal", ...overrides };
}

function withFamily(family: Family, pref: RouterSettings["families"][Family], base = settings()): RouterSettings {
  return { ...base, families: { ...base.families, [family]: pref } };
}

const KB = 1024;

describe("registry", () => {
  it("resolves the latest stable model per family", () => {
    assert.equal(registry.latest("haiku", "stable").id, "claude-haiku-5-5");
    assert.equal(registry.latest("sonnet", "stable").id, "claude-sonnet-5-5");
    assert.equal(registry.latest("opus", "stable").id, "claude-opus-5-5");
    assert.equal(registry.latest("fable", "stable").id, "claude-fable-5-1");
  });

  it("prefers an experimental build only in experimental mode", () => {
    const data = structuredClone(rawRegistry);
    data.models.push({ ...data.models.find((m: { id: string }) => m.id === "claude-sonnet-5-5"), id: "claude-sonnet-x", version: "5.6", channel: "experimental" });
    const reg = new ModelRegistry(validateRegistry(data));
    assert.equal(reg.latest("sonnet", "stable").id, "claude-sonnet-5-5");
    assert.equal(reg.latest("sonnet", "experimental").id, "claude-sonnet-x");
  });

  it("detects retired ids by list and pattern", () => {
    assert.ok(registry.isRetired("claude-3-5-sonnet-20241022"));
    assert.ok(registry.isRetired("claude-3-5-sonnet-latest"));
    assert.ok(registry.isRetired("claude-3-opus-something"));
    assert.ok(!registry.isRetired("claude-sonnet-5-5"));
    assert.ok(!registry.isRetired("my-org-custom-model"));
  });

  it("rejects malformed registries", () => {
    assert.throws(() => validateRegistry({ schemaVersion: 2 }), RegistryError);
    const missingFamily = structuredClone(rawRegistry);
    missingFamily.models = missingFamily.models.filter((m: { family: string }) => m.family !== "fable");
    assert.throws(() => validateRegistry(missingFamily), /fable/);
  });

  it("matches the snapshot enums in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const props = pkg.contributes.configuration.properties;
    for (const f of FAMILIES) {
      const ids = registry.models().filter((m) => m.family === f).map((m) => m.id);
      assert.deepEqual(props[`claudeRouter.${f}.snapshot`].enum, ids, `snapshot enum for ${f} is out of date`);
    }
  });
});

describe("prefix parser", () => {
  it("parses family and exact-version prefixes and strips them", () => {
    assert.deepEqual(parsePrefix("/opus why is this slow", registry), { kind: "family", family: "opus", prompt: "why is this slow" });
    const exact = parsePrefix("/sonnet-5.5 add a test", registry);
    assert.equal(exact.kind, "model");
    assert.equal(exact.kind === "model" && exact.model.id, "claude-sonnet-5-5");
    assert.equal(exact.kind === "model" && exact.prompt, "add a test");
    const noHyphen = parsePrefix("/fable5.1 migrate", registry);
    assert.equal(noHyphen.kind === "model" && noHyphen.model.id, "claude-fable-5-1");
  });

  it("flags unknown model prefixes", () => {
    assert.deepEqual(parsePrefix("/sonnet9 hi", registry), { kind: "unknown", token: "/sonnet9" });
    assert.deepEqual(parsePrefix("/sonnet-3.5 hi", registry), { kind: "unknown", token: "/sonnet-3.5" });
  });

  it("ignores non-routing slashes", () => {
    assert.equal(parsePrefix("/explain this", registry).kind, "none");
    assert.equal(parsePrefix("/usr/bin/env is missing", registry).kind, "none");
    assert.equal(parsePrefix("please /opus", registry).kind, "none");
  });
});

describe("classifier", () => {
  it("judges a small explanation request trivial", () => {
    assert.equal(classify({ prompt: "Explain this syntax error", contextBytes: 2 * KB }).tier, "trivial");
  });

  it("judges implementation work standard", () => {
    assert.equal(classify({ prompt: "Build a route controller for /users", contextBytes: 20 * KB }).tier, "standard");
  });

  it("judges deep reasoning complex", () => {
    assert.equal(classify({ prompt: "Find the deep architectural memory leak", contextBytes: 40 * KB }).tier, "complex");
  });

  it("judges agentic multi-step work expert", () => {
    assert.equal(classify({ prompt: "Migrate all services to the new SDK and iterate until tests pass", contextBytes: 40 * KB }).tier, "expert");
  });

  it("defaults the top tier to complex for large context with no intent", () => {
    assert.equal(classify({ prompt: "look at this", contextBytes: 300 * KB }).tier, "complex");
  });

  it("maps every tier onto a family exactly once", () => {
    assert.deepEqual(TIERS.map((t) => TIER_TO_FAMILY[t]), ["haiku", "sonnet", "opus", "fable"]);
    for (const f of FAMILIES) assert.equal(TIER_TO_FAMILY[FAMILY_TO_TIER[f]], f);
  });
});

describe("workspace constraints", () => {
  const t = registry.data.strictModern;

  it("flags modern npm, tsconfig, python and go projects", () => {
    assert.ok(evaluateWorkspace({ packageJson: JSON.stringify({ dependencies: { react: "^19.1.0" } }) }, t).strictModern);
    assert.ok(evaluateWorkspace({ tsconfigJson: '{ // c\n "compilerOptions": { "target": "ESNext" } }' }, t).strictModern);
    assert.ok(evaluateWorkspace({ pyprojectToml: 'requires-python = ">=3.12"' }, t).strictModern);
    assert.ok(evaluateWorkspace({ requirementsTxt: "django==5.1.2\n" }, t).strictModern);
    assert.ok(evaluateWorkspace({ goMod: "module x\n\ngo 1.23\n" }, t).strictModern);
  });

  it("leaves older projects alone", () => {
    const profile = evaluateWorkspace(
      { packageJson: JSON.stringify({ dependencies: { react: "^18.2.0" } }), tsconfigJson: '{"compilerOptions":{"target":"ES2020"}}', goMod: "go 1.20" },
      t,
    );
    assert.deepEqual(profile, { strictModern: false, markers: [] });
  });
});

describe("router precedence", () => {
  const base = { contextBytes: 2 * KB, strictModern: false };

  it("1. prefix bypasses pins", () => {
    const d = route(registry, { ...base, prompt: "/opus-4.8 hello", settings: settings({ pinnedFamily: "haiku" }) });
    assert.equal(d.source, "prefix");
    assert.equal(d.providerModelId, "claude-opus-4-8");
    assert.equal(d.prompt, "hello");
  });

  it("1. unknown prefix aborts", () => {
    assert.throws(() => route(registry, { ...base, prompt: "/sonnet9 hi", settings: settings() }), (e: unknown) => e instanceof RoutingError && e.message === "Unknown routing prefix: /sonnet9");
  });

  it("2. pin wins over a complex classification, with a notice", () => {
    const d = route(registry, { ...base, prompt: "Find the deep architectural memory leak", contextBytes: 200 * KB, settings: settings({ pinnedFamily: "haiku" }) });
    assert.equal(d.providerModelId, "claude-haiku-5-5");
    assert.equal(d.source, "pin");
    assert.deepEqual(d.notices, ["$(warning) Using pinned Haiku for complex task"]);
  });

  it("2. pinned snapshot is honoured", () => {
    const d = route(registry, { ...base, prompt: "fix typo", settings: withFamily("haiku", { channel: "snapshot", snapshot: "claude-haiku-4-5" }) });
    assert.equal(d.providerModelId, "claude-haiku-4-5");
  });

  it("2. retired custom id maps to the family's current model with a warning", () => {
    const d = route(registry, { ...base, prompt: "x", settings: withFamily("sonnet", { channel: "custom", customModelId: "claude-3-5-sonnet-latest" }, settings({ pinnedFamily: "sonnet" })) });
    assert.equal(d.providerModelId, "claude-sonnet-5-5");
    assert.deepEqual(d.warnings, [LEGACY_MAPPED_WARNING]);
  });

  it("2. unknown custom ids pass through unvalidated", () => {
    const d = route(registry, { ...base, prompt: "x", settings: withFamily("sonnet", { channel: "custom", customModelId: "my-proxy-model" }, settings({ pinnedFamily: "sonnet" })) });
    assert.equal(d.providerModelId, "my-proxy-model");
    assert.equal(d.model, undefined);
  });

  it("3. strict-modern upgrades a legacy generation within the same family", () => {
    const s = withFamily("haiku", { channel: "snapshot", snapshot: "claude-haiku-4-5" }, settings({ pinnedFamily: "haiku" }));
    const d = route(registry, { ...base, prompt: "x", settings: s, strictModern: true });
    assert.equal(d.providerModelId, "claude-haiku-5-5");
    assert.equal(d.family, "haiku");
    assert.match(d.notices[0], /upgraded to Claude Haiku 5\.5/);
  });

  it("3. strict-modern keeps a same-generation pin", () => {
    const s = withFamily("sonnet", { channel: "snapshot", snapshot: "claude-sonnet-5" }, settings({ pinnedFamily: "sonnet" }));
    assert.equal(route(registry, { ...base, prompt: "x", settings: s, strictModern: true }).providerModelId, "claude-sonnet-5");
  });

  it("4. classifier decides when nothing else applies", () => {
    const d = route(registry, { ...base, prompt: "Build a route controller", contextBytes: 20 * KB, settings: settings() });
    assert.equal(d.source, "classifier");
    assert.equal(d.label, "Claude Sonnet 5.5");
    assert.equal(d.icon, "zap");
  });

  it("uses provider-specific ids and errors when a model is not offered", () => {
    const bedrock = settings({ provider: "bedrock", pinnedFamily: "opus" });
    assert.equal(route(registry, { ...base, prompt: "x", settings: bedrock }).providerModelId, "anthropic.claude-opus-5-5");
    assert.throws(() => route(registry, { ...base, prompt: "/opus-4.8 x", settings: bedrock }), RoutingError);
    const vertex = withFamily("opus", { channel: "snapshot", snapshot: "claude-opus-4-5" }, settings({ provider: "vertex", pinnedFamily: "opus" }));
    assert.equal(route(registry, { ...base, prompt: "x", settings: vertex }).providerModelId, "claude-opus-4-5@20251101");
  });

  it("warns on deprecated models", () => {
    const d = route(registry, { ...base, prompt: "/sonnet-4.5 x", settings: settings() });
    assert.match(d.warnings[0], /deprecated and retires on 2026-11-30/);
  });
});

describe("escalation", () => {
  const base = { contextBytes: 2 * KB, strictModern: false };

  it("steps one tier up and stops at the top", () => {
    assert.equal(nextFamily("haiku"), "sonnet");
    assert.equal(nextFamily("sonnet"), "opus");
    assert.equal(nextFamily("opus"), "fable");
    assert.equal(nextFamily("fable"), undefined);
  });

  it("offers the handoff to every tier except the top", () => {
    for (const f of ["haiku", "sonnet", "opus"] as const) assert.ok(systemPromptFor("base", f).includes(ESCALATE_TOKEN), f);
    assert.equal(systemPromptFor("base", "fable"), "base");
  });

  it("recognises the ESCALATE reply and nothing else", () => {
    for (const text of ["ESCALATE", "  escalate\n", "**ESCALATE**", "ESCALATE."]) assert.ok(isEscalationRequest(text), text);
    for (const text of ["I would ESCALATE this", "ESCALATE the ticket to ops", "", "done"]) assert.ok(!isEscalationRequest(text), text);
  });

  it("floor raises the classifier result with a notice", () => {
    const d = route(registry, { ...base, prompt: "fix typo", settings: settings(), minFamily: "opus" });
    assert.equal(d.family, "opus");
    assert.equal(d.source, "escalation");
    assert.equal(d.providerModelId, "claude-opus-5-5");
    assert.deepEqual(d.notices, ["$(arrow-up) Escalated from Haiku to Opus"]);
  });

  it("floor raises a pin too, but never lowers a higher result", () => {
    const pinned = route(registry, { ...base, prompt: "fix typo", settings: settings({ pinnedFamily: "haiku" }), minFamily: "sonnet" });
    assert.equal(pinned.family, "sonnet");
    const higher = route(registry, { ...base, prompt: "fix typo", settings: settings({ pinnedFamily: "fable" }), minFamily: "sonnet" });
    assert.equal(higher.family, "fable");
    assert.equal(higher.source, "pin");
  });

  it("prefix still bypasses the floor", () => {
    const d = route(registry, { ...base, prompt: "/haiku hi", settings: settings(), minFamily: "opus" });
    assert.equal(d.family, "haiku");
    assert.equal(d.source, "prefix");
  });
});

describe("decision log", () => {
  const base = { contextBytes: 2 * KB, strictModern: false };
  const first = route(registry, { ...base, prompt: "fix typo", settings: settings() });
  const final = route(registry, { ...base, prompt: "fix typo", settings: settings(), minFamily: "sonnet" });
  const outcome = { surface: "chat" as const, prompt: "fix typo", contextBytes: 2 * KB, first, final, escalations: [{ from: "haiku" as const, to: "sonnet" as const, by: "model" as const }], stopReason: "end_turn" };

  it("records the first decision, what served, and the escalation", () => {
    const e = buildEntry(outcome, true, new Date("2026-01-02T03:04:05Z"));
    assert.equal(e.ts, "2026-01-02T03:04:05.000Z");
    assert.equal(e.prompt, "fix typo");
    assert.deepEqual(e.decided, { family: "haiku", source: "classifier", model: "claude-haiku-5-5" });
    assert.deepEqual(e.served, { family: "sonnet", model: "claude-sonnet-5-5" });
    assert.deepEqual(e.escalations, outcome.escalations);
    assert.equal(e.scores?.trivial, first.classification?.scores.trivial);
    assert.equal(e.tier, first.classification?.tier);
    assert.equal(e.stopReason, "end_turn");
  });

  it("omits the prompt text when asked, keeping its size", () => {
    const e = buildEntry(outcome, false);
    assert.equal("prompt" in e, false);
    assert.equal(e.promptChars, 8);
    assert.equal(e.contextBytes, 2 * KB);
  });

  describe("parseDecisionLog", () => {
    const line = (promptChars: number) =>
      JSON.stringify(buildEntry({ ...outcome, prompt: "x".repeat(promptChars) }, true, new Date()));

    it("returns most-recent-first", () => {
      const text = [line(1), line(2), line(3)].join("\n") + "\n";
      const entries = parseDecisionLog(text);
      assert.deepEqual(entries.map((e) => e.promptChars), [3, 2, 1]);
    });

    it("skips a corrupt line instead of failing the whole read", () => {
      const text = [line(1), "{not valid json", line(2)].join("\n");
      const entries = parseDecisionLog(text);
      assert.deepEqual(entries.map((e) => e.promptChars), [2, 1]);
    });

    it("ignores blank lines", () => {
      const text = `${line(1)}\n\n\n${line(2)}\n`;
      assert.equal(parseDecisionLog(text).length, 2);
    });

    it("caps at the limit, keeping the most recent", () => {
      const text = [line(1), line(2), line(3), line(4)].join("\n");
      const entries = parseDecisionLog(text, 2);
      assert.deepEqual(entries.map((e) => e.promptChars), [4, 3]);
    });

    it("returns an empty array for empty input", () => {
      assert.deepEqual(parseDecisionLog(""), []);
    });
  });
});
