// Which files an Agent package lists in its manifest and puts into its archive.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/**
 * Finder writes `.DS_Store` into any folder it shows, also while a build is running, and rewrites it
 * later. It is never part of the package: listed in the manifest, it breaks the integrity check on import.
 */
export const FINDER_METADATA = ".DS_Store";

/** Every package file except Finder metadata, sorted by path, with size and SHA-256 (or the link target). */
export function collectFiles(root, current = root) {
  const entries = [];
  for (const name of readdirSync(current)) {
    if (name === FINDER_METADATA) continue;
    const absolute = join(current, name);
    const relativePath = relative(root, absolute).split(sep).join("/");
    const info = lstatSync(absolute);
    if (info.isDirectory()) entries.push(...collectFiles(root, absolute));
    else if (info.isSymbolicLink()) entries.push({ path: relativePath, symlink: readlinkSync(absolute) });
    else if (info.isFile()) entries.push({ path: relativePath, size: info.size, sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex") });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

/** `tar` arguments for a `.tar.gz` of the package directory, leaving out Finder metadata (bsdtar and GNU tar). */
export function tarArguments(packageRoot, archivePath) {
  return ["-czf", archivePath, `--exclude=${FINDER_METADATA}`, "-C", dirname(packageRoot), relative(dirname(packageRoot), packageRoot)];
}
