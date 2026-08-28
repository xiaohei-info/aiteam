/** Parse roster-authorized @handles; display-name aliases are normalized to handles. */
export function parseMentions(text: string, knownHandles: Set<string>, aliases: ReadonlyMap<string, string> = new Map()): string[] {
  const matches = text.match(/@([^\s@]+)/g) ?? [];
  const seen = new Set<string>();
  for (const match of matches) {
    const typed = match.slice(1);
    const handle = knownHandles.has(typed) ? typed : aliases.get(typed);
    if (handle && !seen.has(handle)) seen.add(handle);
  }
  return [...seen];
}
