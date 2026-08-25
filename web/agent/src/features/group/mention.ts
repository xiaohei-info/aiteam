/** Parse only roster-authorized @handles from a group prompt. */
export function parseMentions(text: string, knownHandles: Set<string>): string[] {
  const matches = text.match(/@([^\s@]+)/g) ?? [];
  const seen = new Set<string>();
  for (const match of matches) {
    const handle = match.slice(1);
    if (knownHandles.has(handle) && !seen.has(handle)) seen.add(handle);
  }
  return [...seen];
}
