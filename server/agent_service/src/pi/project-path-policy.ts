import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

type PlatformPolicy = {
  home_roots: string[];
  system_roots: string[];
  short_names?: Record<string, string[]>;
};

type ProjectPathPolicy = {
  version: number;
  macos: PlatformPolicy;
  windows: PlatformPolicy;
};

const POLICY_FILE = "project-sensitive-paths.json";

function loadPolicy(): ProjectPathPolicy {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.AITEAM_PROJECT_PATH_POLICY,
    join(sourceDir, "../../../../shared", POLICY_FILE),
    join(sourceDir, "../../config", POLICY_FILE),
    join(process.cwd(), "shared", POLICY_FILE),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(readFileSync(candidate, "utf8")) as ProjectPathPolicy;
      if (value.version === 1 && value.macos && value.windows) return value;
    } catch {
      // Try the next source. A packaged Agent has the policy in config/.
    }
  }
  throw new Error("The shared project path policy is unavailable");
}

const POLICY = loadPolicy();

function platformPolicy(platform: string): PlatformPolicy {
  return platform === "win32" ? POLICY.windows : POLICY.macos;
}

function normalizePosix(path: string): string {
  const value = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return value || "/";
}

function normalizeWindows(path: string): string {
  const value = win32.normalize(path.replaceAll("/", "\\")).replace(/[\\/]+$/u, "");
  return value.toLowerCase() || win32.parse(path).root.toLowerCase();
}

function isWithin(path: string, parent: string, platform: string): boolean {
  const relativePath = platform === "win32"
    ? win32.relative(normalizeWindows(parent), normalizeWindows(path))
    : relative(normalizePosix(parent), normalizePosix(path));
  const absoluteRelative = platform === "win32" ? win32.isAbsolute(relativePath) : isAbsolute(relativePath);
  return relativePath === "" || (!relativePath.startsWith(`..${platform === "win32" ? "\\" : sep}`) && relativePath !== ".." && !absoluteRelative);
}

function pathSegments(path: string, platform: string): string[] {
  const normalized = platform === "win32" ? normalizeWindows(path) : normalizePosix(path);
  return normalized.split(platform === "win32" ? /[\\/]+/u : "/").filter(Boolean).map((part) => part.toLowerCase());
}

function windowsRoot(path: string): string {
  return win32.parse(normalizeWindows(path)).root;
}

function expandRoots(roots: readonly string[], platform: string, home: string): string[] {
  if (platform !== "win32") return roots.map((entry) => normalizePosix(join(home, entry)));
  const homePath = normalizeWindows(home);
  return roots.map((entry) => {
    if (/^[a-z]:[\\/]/iu.test(entry) || entry.startsWith("\\\\")) return normalizeWindows(entry);
    return normalizeWindows(win32.join(homePath, entry));
  });
}

function sensitiveNames(policy: PlatformPolicy): Set<string> {
  const names = new Set<string>();
  for (const root of policy.home_roots) names.add(root.split(/[\\/]+/u).at(-1)!.toLowerCase());
  for (const aliases of Object.values(policy.short_names ?? {})) for (const alias of aliases) names.add(alias.toLowerCase());
  return names;
}

function sensitiveRoots(policy: PlatformPolicy, platform: string, home: string): { path: string; exactOnly: boolean }[] {
  const roots = expandRoots(policy.home_roots, platform, home).map((path) => ({ path, exactOnly: false }));
  if (platform === "win32") {
    roots.push({ path: windowsRoot(home), exactOnly: true });
    const homePath = normalizeWindows(home);
    for (const entry of policy.home_roots) {
      for (const alias of policy.short_names?.[entry] ?? []) {
        roots.push({ path: normalizeWindows(win32.join(homePath, alias)), exactOnly: false });
      }
    }
  }
  const system = platform === "win32"
    ? policy.system_roots.flatMap((entry) => {
      const path = normalizeWindows(win32.join(windowsRoot(home), entry));
      const aliases = policy.short_names?.[entry] ?? [];
      return [path, ...aliases.map((alias) => normalizeWindows(win32.join(windowsRoot(home), alias)))].map((value) => ({ path: value, exactOnly: false }));
    })
    : policy.system_roots.map((path) => ({ path: normalizePosix(path), exactOnly: normalizePosix(path) === "/" }));
  return [...roots, ...system];
}

function canonicalForPolicy(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * Rejects a project that is sensitive itself, inside a sensitive tree, or contains one.
 * The optional platform parameter makes Windows path rules testable on macOS/Linux.
 */
export function isAllowedProjectFolder(
  path: string,
  runtimeRoots: readonly string[],
  home = homedir(),
  platform = process.platform,
): boolean {
  const policy = platformPolicy(platform);
  const candidate = canonicalForPolicy(path);
  if (platform === "win32" ? !win32.isAbsolute(candidate) : !isAbsolute(candidate)) return false;
  const sensitive = sensitiveRoots(policy, platform, home);
  if (pathSegments(candidate, platform).some((segment) => sensitiveNames(policy).has(segment))) return false;
  if (sensitive.some(({ path: root, exactOnly }) => exactOnly ? pathSegments(candidate, platform).join("/") === pathSegments(root, platform).join("/") : isWithin(candidate, root, platform) || isWithin(root, candidate, platform))) return false;
  return !runtimeRoots.some((root) => isWithin(candidate, canonicalForPolicy(root), platform) || isWithin(canonicalForPolicy(root), candidate, platform));
}

export function projectPathPolicyForTests(): ProjectPathPolicy {
  return POLICY;
}
