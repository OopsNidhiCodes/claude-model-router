/** Removes a single wrapping Markdown fence if the model added one anyway. */
export function stripFences(text: string): string {
  const match = /^\s*```[\w+-]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return match ? match[1] : text;
}
