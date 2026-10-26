import { FAMILIES, Family, ModelEntry, ProviderName, Registry, ReleaseChannel } from "./types";
import { compareVersions, parseVersion } from "./version";

export class RegistryError extends Error {}

/** Validates parsed JSON and returns it typed. Throws RegistryError with the first problem found. */
export function validateRegistry(data: unknown): Registry {
  const reg = data as Registry;
  if (!reg || typeof reg !== "object") throw new RegistryError("registry is not an object");
  if (reg.schemaVersion !== 1) throw new RegistryError(`unsupported schemaVersion ${String(reg.schemaVersion)}`);
  for (const family of FAMILIES) {
    if (!reg.families?.[family]) throw new RegistryError(`missing family "${family}"`);
  }
  if (!Array.isArray(reg.models) || reg.models.length === 0) throw new RegistryError("models must be a non-empty array");
  const seen = new Set<string>();
  for (const m of reg.models) {
    if (!m.id || seen.has(m.id)) throw new RegistryError(`duplicate or empty model id "${m.id}"`);
    seen.add(m.id);
    if (!FAMILIES.includes(m.family)) throw new RegistryError(`model ${m.id} has unknown family "${m.family}"`);
    if (!parseVersion(m.version)) throw new RegistryError(`model ${m.id} has unparseable version "${m.version}"`);
    if (!m.providers || Object.keys(m.providers).length === 0) throw new RegistryError(`model ${m.id} has no provider ids`);
  }
  for (const family of FAMILIES) {
    if (!reg.models.some((m) => m.family === family && m.channel === "stable" && m.status !== "deprecated")) {
      throw new RegistryError(`family "${family}" has no stable model`);
    }
  }
  reg.retired ??= [];
  reg.retiredPatterns ??= [];
  for (const p of reg.retiredPatterns) {
    try {
      new RegExp(p);
    } catch {
      throw new RegistryError(`invalid retired pattern ${p}`);
    }
  }
  return reg;
}

export class ModelRegistry {
  private readonly byId = new Map<string, ModelEntry>();
  private readonly byAlias = new Map<string, ModelEntry>();
  private readonly retiredIds: Set<string>;
  private readonly retiredRes: RegExp[];

  constructor(readonly data: Registry) {
    for (const m of data.models) {
      this.byId.set(m.id, m);
      for (const providerId of Object.values(m.providers)) {
        if (providerId) this.byId.set(providerId, m);
      }
      // "sonnet-5.5", "fable-5", ...
      this.byAlias.set(`${m.family}-${m.version}`, m);
    }
    this.retiredIds = new Set(data.retired);
    this.retiredRes = data.retiredPatterns.map((p) => new RegExp(p));
  }

  family(family: Family) {
    return this.data.families[family];
  }

  /** Looks up a registry id or any provider-specific id. */
  find(id: string): ModelEntry | undefined {
    return this.byId.get(id);
  }

  findAlias(alias: string): ModelEntry | undefined {
    return this.byAlias.get(alias);
  }

  /**
   * The newest non-deprecated model of a family. In experimental mode an
   * experimental build wins over a stable one; otherwise only stable builds count.
   */
  latest(family: Family, channel: ReleaseChannel): ModelEntry {
    const candidates = this.data.models.filter(
      (m) => m.family === family && m.status !== "deprecated" && (channel === "experimental" || m.channel === "stable"),
    );
    candidates.sort((a, b) => {
      if (channel === "experimental" && a.channel !== b.channel) return a.channel === "experimental" ? -1 : 1;
      return compareVersions(parseVersion(b.version)!, parseVersion(a.version)!);
    });
    // validateRegistry guarantees at least one stable entry per family.
    return candidates[0];
  }

  isRetired(id: string): boolean {
    if (this.byId.has(id)) return false;
    return this.retiredIds.has(id) || this.retiredRes.some((re) => re.test(id));
  }

  models(): readonly ModelEntry[] {
    return this.data.models;
  }

  providerId(model: ModelEntry, provider: ProviderName): string | undefined {
    return model.providers[provider];
  }
}

/** Finds a family name inside a model string ("claude-3-5-sonnet-latest" -> "sonnet"). Mythos maps to Fable. */
export function familyFromModelId(id: string): Family | undefined {
  const match = /(haiku|sonnet|opus|fable|mythos)/i.exec(id);
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  return name === "mythos" ? "fable" : (name as Family);
}
