import { createHash } from "node:crypto";

export class InvalidReadCursorError extends Error {
  constructor() {
    super("Invalid cursor or cursor scope");
    this.name = "InvalidReadCursorError";
  }
}

/** Cursors select a boundary, never confer authority; readers must still scope every query. */
export function readCursorScope(resource: string, owner: readonly unknown[], filters: readonly unknown[] = []): string {
  return createHash("sha256").update(JSON.stringify([resource, owner, filters])).digest("base64url");
}

export function encodeReadCursor(scope: string, boundary: readonly (string | number)[]): string {
  return `page_v1.${Buffer.from(JSON.stringify({ v: 1, scope, boundary })).toString("base64url")}`;
}

export function decodeReadCursor(cursor: string, scope: string, types: readonly ("string" | "number")[]): (string | number)[] {
  try {
    if (cursor.length > 8192 || !/^page_v1\.[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidReadCursorError();
    const encoded = cursor.slice(8);
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new InvalidReadCursorError();
    const value = JSON.parse(bytes.toString("utf8"));
    if (value.v !== 1 || value.scope !== scope || !Array.isArray(value.boundary) || value.boundary.length !== types.length) throw new InvalidReadCursorError();
    if (value.boundary.some((item: unknown, index: number) => typeof item !== types[index] || (typeof item === "number" && !Number.isSafeInteger(item)))) throw new InvalidReadCursorError();
    return value.boundary;
  } catch {
    throw new InvalidReadCursorError();
  }
}

export function compareReadOrder(left: readonly (string | number)[], right: readonly (string | number)[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}
