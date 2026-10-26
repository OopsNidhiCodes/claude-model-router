/** Parses the first dotted number in a string: "^19.0.0" -> [19, 0, 0], ">=3.12" -> [3, 12]. */
export function parseVersion(text: string): number[] | undefined {
  const match = /(\d+(?:\.\d+)*)/.exec(text);
  return match ? match[1].split(".").map(Number) : undefined;
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when `actual` (a version or range string) is at least `minimum`. */
export function meetsMinimum(actual: string, minimum: string): boolean {
  const a = parseVersion(actual);
  const m = parseVersion(minimum);
  return a !== undefined && m !== undefined && compareVersions(a, m) >= 0;
}

export function generationOf(version: string): number {
  return parseVersion(version)?.[0] ?? 0;
}
