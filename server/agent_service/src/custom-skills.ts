/**
 * Custom skills imported by the member themselves (design 2026-11-18 §3).
 *
 * Unlike `SkillCache`, this store holds unsigned packages: the member brings a folder, a zip, pasted
 * SKILL.md text or a https URL. Nothing leaves the machine. Every file is recorded with its sha256, so a
 * later change on disk is detected instead of being silently used.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { unzipSync } from "fflate";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

export const MAX_SKILL_FILES = 256;
export const MAX_SKILL_BYTES = 10 * 1024 * 1024;
export const MAX_SINGLE_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 20_000;

/** A skill package as the store sees it: a name, a description and its files. */
export interface CustomSkillPackage {
  name: string;
  description: string;
  files: { path: string; content: Buffer }[];
  /** Where it came from, for the capability row and the UI. */
  origin: { kind: "folder" | "zip" | "file" | "text" | "url" | "clawhub"; label: string; url?: string };
}

export interface CustomSkillPreview {
  name: string;
  description: string;
  file_count: number;
  total_bytes: number;
  files: string[];
  origin_label: string;
}

export interface CustomSkillRecord {
  name: string;
  description: string;
  origin: { kind: "folder" | "zip" | "file" | "text" | "url" | "clawhub"; label: string; url?: string };
  version: string;
}

export class CustomSkillError extends Error {
  constructor(readonly code: "invalid_skill_package" | "skill_download_failed" | "skill_too_large" | "skill_ambiguous", message: string) {
    super(message);
    this.name = "CustomSkillError";
  }
}

interface Manifest {
  name: string;
  description: string;
  origin: { kind: "folder" | "zip" | "file" | "text" | "url" | "clawhub"; label: string; url?: string };
  files: { path: string; size: number; sha256: string }[];
  content_hash: string;
}

const SKIP_DIRS = new Set([".git", "__MACOSX"]);
const SKIP_FILES = new Set([".DS_Store"]);

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function safeSegment(value: string, what: string): string {
  if (!value || value.length > 120 || !/^[A-Za-z0-9._-]+$/.test(value)) throw new CustomSkillError("invalid_skill_package", `${what} 无效：只能是字母、数字、点、下划线、连字符，最长 120 字符。`);
  return value;
}

/** A relative path inside the package: no traversal, no absolute paths, no drive letters. */
function safeRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized || normalized.length > 240 || isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) throw new CustomSkillError("invalid_skill_package", `路径无效：${path}`);
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new CustomSkillError("invalid_skill_package", `路径不能含上级目录或空段：${path}`);
  return parts.join(sep);
}

function checkLimits(files: { path: string; content: Buffer }[]): void {
  if (files.length === 0) throw new CustomSkillError("invalid_skill_package", "包里没有文件。");
  if (files.length > MAX_SKILL_FILES) throw new CustomSkillError("skill_too_large", `文件数超过上限（${MAX_SKILL_FILES} 个）。`);
  const total = files.reduce((sum, file) => sum + file.content.length, 0);
  if (total > MAX_SKILL_BYTES) throw new CustomSkillError("skill_too_large", `技能总大小超过上限（${Math.round(MAX_SKILL_BYTES / 1024 / 1024)} MiB）。`);
  for (const file of files) if (file.content.length > MAX_SINGLE_FILE_BYTES) {
    throw new CustomSkillError("skill_too_large", `单个文件超过上限（${Math.round(MAX_SINGLE_FILE_BYTES / 1024 / 1024)} MiB）：${file.path}`);
  }
}

/**
 * Finds the directory that holds SKILL.md: the package root, or its only top-level folder (zips and
 * GitHub subdirectories usually wrap the skill one level deep).
 */
export function skillRootOf(files: { path: string; content: Buffer }[]): string | undefined {
  const skillMd = files.find((file) => file.path === join("SKILL.md"));
  if (skillMd) return "";
  const roots = new Set<string>();
  for (const file of files) {
    const parts = file.path.split(sep);
    if (parts.length > 1 && parts[0] && !SKIP_DIRS.has(parts[0])) roots.add(parts[0]!);
  }
  return roots.size === 1 ? [...roots][0] : undefined;
}

/** Normalizes any package into `{name, description, files}` under the skill root, validating with Pi itself. */
export function normalizeSkillPackage(files: { path: string; content: Buffer }[], origin: CustomSkillPackage["origin"]): CustomSkillPackage {
  const safe = files.map((file) => ({ path: safeRelativePath(file.path), content: file.content }));
  const root = skillRootOf(safe);
  if (root === undefined) throw new CustomSkillError("invalid_skill_package", "找不到 SKILL.md：技能根目录要直接含 SKILL.md，或只有一个顶层文件夹含 SKILL.md。");
  return normalizeSkillAtRoot(safe, root, origin);
}

/** 一个文件夹 / 压缩包里可能有多个技能：列出所有含 SKILL.md 的目录（每个技能一个根），按路径排序去重。 */
export function scanSkillRoots(files: { path: string; content: Buffer }[]): string[] {
  const safe = files.map((file) => safeRelativePath(file.path));
  const roots = new Set<string>();
  for (const path of safe) {
    const parts = path.split(sep);
    if (parts[parts.length - 1] !== "SKILL.md") continue;
    roots.add(parts.length === 1 ? "" : parts.slice(0, -1).join(sep));
  }
  return [...roots].sort();
}

/** 校验并规范化指定根下的技能文件。 */
export function normalizeSkillAtRoot(safe: { path: string; content: Buffer }[], root: string, origin: CustomSkillPackage["origin"]): CustomSkillPackage {
  checkLimits(safe);
  const prefix = root ? root + sep : "";
  const inRoot = safe.filter((file) => !root || file.path.startsWith(prefix))
    .map((file) => ({ path: file.path.slice(prefix.length), content: file.content }));
  const probe = join(tmpdir(), `aiteam-custom-skill-${process.pid}-${Date.now()}`);
  try {
    for (const file of inRoot) {
      const target = join(probe, file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, file.content, { mode: 0o600 });
    }
    const loaded = loadSkillsFromDir({ dir: probe, source: "aiteam-custom-skill" });
    if (loaded.skills.length !== 1) throw new CustomSkillError("invalid_skill_package", "这个技能包加载后得不到唯一技能，请检查 SKILL.md。");
    const skill = loaded.skills[0]!;
    // Pi 只对 name 不规范给 warning，但仍会加载——那会让员工拿到一个用不了的技能，所以这里直接拒绝。
    if (!/^[a-z0-9-]+$/.test(skill.name)) throw new CustomSkillError("invalid_skill_package", "name 只能用小写字母、数字和连字符。");
    if (skill.name.length > 64 || skill.name.startsWith("-") || skill.name.endsWith("-") || skill.name.includes("--")) {
      throw new CustomSkillError("invalid_skill_package", "name 不能超过 64 字符，也不能以连字符开头或结尾、含连续连字符。");
    }
    if (!skill.description.trim()) throw new CustomSkillError("invalid_skill_package", "description 必填。");
    return { name: skill.name, description: skill.description, files: inRoot, origin };
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/** 内容哈希（版本）：同一份内容恒得同一值。审批摘要带它，执行时比对，避免批准后内容被换掉。 */
export function skillContentHash(pkg: CustomSkillPackage): string {
  return manifestFor(pkg).contentHash;
}

function manifestFor(pkg: CustomSkillPackage): { manifest: Manifest; contentHash: string } {
  const files = pkg.files.map((file) => ({ path: file.path, size: file.content.length, sha256: sha256(file.content) }));
  const contentHash = sha256(Buffer.from(JSON.stringify(files)));
  return {
    manifest: { name: pkg.name, description: pkg.description, origin: pkg.origin, files, content_hash: contentHash },
    contentHash,
  };
}

export class CustomSkillStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.assertDirectory(this.root);
  }

  private assertDirectory(path: string): void {
    if (existsSync(path) && !lstatSync(path).isDirectory()) throw new CustomSkillError("invalid_skill_package", `不是目录：${path}`);
  }

  private scopeRoot(scope: { tenantId: string; memberId: string }): string {
    const root = join(this.root, safeSegment(scope.tenantId, "tenant_id"), safeSegment(scope.memberId, "member_id"));
    this.assertDirectory(root);
    return root;
  }

  private skillDir(scope: { tenantId: string; memberId: string }, name: string): string {
    return join(this.scopeRoot(scope), safeSegment(name, "skill name"));
  }

  /** Verifies the manifest against the files on disk; a mismatch means the member edited them. */
  private readManifest(scope: { tenantId: string; memberId: string }, name: string): { dir: string; manifest: Manifest; modified: boolean } | undefined {
    const dir = this.skillDir(scope, name);
    if (!existsSync(dir)) return undefined;
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) return undefined;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    if (manifest.name !== name || !Array.isArray(manifest.files) || typeof manifest.content_hash !== "string") return undefined;
    let modified = false;
    for (const file of manifest.files) {
      const path = join(dir, "files", file.path);
      if (!existsSync(path) || !lstatSync(path).isFile()) { modified = true; continue; }
      if (lstatSync(path).isSymbolicLink()) { modified = true; continue; }
      if (sha256(readFileSync(path)) !== file.sha256) modified = true;
    }
    return { dir, manifest, modified };
  }

  list(scope: { tenantId: string; memberId: string }): { record: CustomSkillRecord; modified: boolean }[] {
    const scopeRoot = this.scopeRoot(scope);
    if (!existsSync(scopeRoot)) return [];
    const out: { record: CustomSkillRecord; modified: boolean }[] = [];
    for (const entry of readdirSync(scopeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const read = this.readManifest(scope, entry.name);
      if (!read) continue;
      out.push({ record: { name: read.manifest.name, description: read.manifest.description, origin: read.manifest.origin, version: read.manifest.content_hash.slice(0, 16) }, modified: read.modified });
    }
    return out.sort((a, b) => a.record.name.localeCompare(b.record.name));
  }

  /** Directory of an unmodified skill, for the session's resource loader; undefined when missing or modified. */
  pathFor(scope: { tenantId: string; memberId: string }, name: string): string | undefined {
    const read = this.readManifest(scope, name);
    return read && !read.modified ? join(read.dir, "files") : undefined;
  }

  /** True when `location` (a skill block's `location`) is one of this member's imported skills. */
  ownsLocation(scope: { tenantId: string; memberId: string }, location: string): boolean {
    const target = resolve(location);
    return this.list(scope).some((item) => this.pathFor(scope, item.record.name) === target);
  }

  remove(scope: { tenantId: string; memberId: string }, name: string): boolean {
    const dir = this.skillDir(scope, name);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** Writes the package to a staging directory, then swaps it in; the previous version survives a failure. */
  install(scope: { tenantId: string; memberId: string }, pkg: CustomSkillPackage): CustomSkillRecord {
    const { manifest, contentHash } = manifestFor(pkg);
    const target = this.skillDir(scope, pkg.name);
    const staging = join(this.scopeRoot(scope), `.${pkg.name}.tmp-${process.pid}-${Date.now()}`);
    try {
      for (const file of pkg.files) {
        const path = join(staging, "files", file.path);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, file.content, { mode: 0o600 });
      }
      writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    return { name: manifest.name, description: manifest.description, origin: manifest.origin, version: contentHash.slice(0, 16) };
  }
}

/**
 * 桌面端文件选择可能给 `file:///Users/…`（Tauri `FilePath::Url` 序列化成字符串）；本机按路径读，先还原。
 * 同时容忍 `file://localhost/…`（URL 规范的主机名写法）。
 */
export function toLocalPath(value: string): string {
  const trimmed = value.trim();
  if (!/^file:\/\//i.test(trimmed)) return trimmed;
  const rest = trimmed.slice("file://".length);
  const path = rest.replace(/^localhost(?=\/)/i, "");
  const decoded = decodeURIComponent(path);
  // Windows：file:///C:/Users/x → C:/Users/x
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

/** Collects a folder: relative paths, no symlinks, no .git / .DS_Store / __MACOSX. */
export async function readSkillFolder(folder: string): Promise<{ path: string; content: Buffer }[]> {
  const root = resolve(toLocalPath(folder));
  if (!existsSync(root)) throw new CustomSkillError("invalid_skill_package", `文件夹不存在：${folder}`);
  if (!lstatSync(root).isDirectory()) throw new CustomSkillError("invalid_skill_package", `不是文件夹：${folder}`);
  const out: { path: string; content: Buffer }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path);
      } else if (stat.isFile()) {
        if (SKIP_FILES.has(entry.name) || entry.name.startsWith(".")) continue;
        out.push({ path: relative(root, path), content: await readFileAsync(path) });
      }
    }
  };
  await walk(root);
  return out;
}

/**
 * Collects one markdown file as a single-file skill package.
 * Pi only loads a skill from a `SKILL.md`, so the file is placed under that name regardless of what it
 * is called on disk; the skill name comes from its frontmatter, never from the filename.
 */
export async function readSkillFile(file: string): Promise<{ path: string; content: Buffer }[]> {
  const target = resolve(toLocalPath(file));
  if (!existsSync(target)) throw new CustomSkillError("invalid_skill_package", `文件不存在：${file}`);
  const stat = lstatSync(target);
  if (!stat.isFile()) throw new CustomSkillError("invalid_skill_package", `不是文件：${file}`);
  if (!/\.md$/i.test(target)) throw new CustomSkillError("invalid_skill_package", "只支持 .md 文件（技能说明）。");
  if (stat.size > MAX_SINGLE_FILE_BYTES) throw new CustomSkillError("skill_too_large", `文件超过 ${Math.floor(MAX_SINGLE_FILE_BYTES / 1024 / 1024)} MiB：${target}`);
  return [{ path: "SKILL.md", content: await readFileAsync(target) }];
}

export interface UrlImport {
  files: { path: string; content: Buffer }[];
  origin: CustomSkillPackage["origin"];
}

/** Downloads a public https URL: a GitHub folder / file, a .md file or a .zip archive. */
export async function fetchSkillFromUrl(rawUrl: string, signal?: AbortSignal): Promise<UrlImport> {
  let url: URL;
  try {
    url = new URL(String(rawUrl ?? "").trim());
  } catch { throw new CustomSkillError("skill_download_failed", "网址无效。"); }
  if (url.protocol !== "https:") throw new CustomSkillError("skill_download_failed", "只支持 https 网址。");
  const github = githubParts(url);
  if (github) return fetchGithub(github, url, signal);
  if (!/\.zip$/i.test(url.pathname) && !/\.md$/i.test(url.pathname)) {
    throw new CustomSkillError("skill_download_failed", "网址只能是 GitHub 链接、以 .md 结尾的文件，或以 .zip 结尾的压缩包。");
  }
  const buffer = await download(url.toString(), signal);
  if (/\.zip$/i.test(url.pathname)) return { files: unzipEntries(buffer), origin: { kind: "url", label: url.toString(), url: url.toString() } };
  return { files: [{ path: "SKILL.md", content: buffer }], origin: { kind: "url", label: url.toString(), url: url.toString() } };
}

/** ClawHub 页面地址：`https://clawhub.ai/{owner}/skills/{slug}`；owner 可省（此时需消歧）。 */
export interface ClawHubParts { owner?: string; slug: string }

export function clawHubParts(value: string): ClawHubParts | undefined {
  let url: URL;
  try { url = new URL(String(value ?? "").trim()); } catch { return undefined; }
  // 只认 clawhub.ai（测试可用 AITEAM_CLAWHUB_BASE_URL 注入本地 mock）。
  if (url.origin !== clawHubOrigin()) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  const skills = parts.indexOf("skills");
  if (skills < 0 || skills + 1 >= parts.length) return undefined;
  const slug = parts[skills + 1]!;
  if (!slug) return undefined;
  const owner = skills > 0 ? parts[skills - 1] : undefined;
  return { ...(owner ? { owner } : {}), slug };
}

/** ClawHub 上同名技能的候选（用户没给 owner 时用来挑）。 */
export interface ClawHubCandidate { owner: string; slug: string; url: string; downloads: number | null }

export interface ClawHubSecurity {
  status: string;
  hasWarnings: boolean;
  scanners: { name: string; status: string; recommendation?: string; severity?: string; verdict?: string; confidence?: string; issueCount?: number }[];
}

/** ClawHub 的 origin。测试可用 AITEAM_CLAWHUB_BASE_URL 指向本地 mock；每次读，避免模块加载时固化。 */
function clawHubOrigin(): string {
  return process.env.AITEAM_CLAWHUB_BASE_URL?.replace(/\/$/, "") || "https://clawhub.ai";
}
const CLAWHUB_FILE_TIMEOUT_MS = 20_000;

async function clawHubJson(raw: string, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAWHUB_FILE_TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const response = await fetch(raw, { signal: controller.signal, headers: { accept: "application/json" } });
    // 409 AMBIGUOUS_SKILL_SLUG 不是错误：正文里的 matches 正是候选清单，交给调用方解析。
    if (!response.ok && response.status !== 409) throw new CustomSkillError("skill_download_failed", `ClawHub 返回 HTTP ${response.status}。`);
    return await response.json() as unknown;
  } catch (error) {
    if (error instanceof CustomSkillError) throw error;
    throw new CustomSkillError("skill_download_failed", "连不上 ClawHub，请稍后再试。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", () => controller.abort());
  }
}

/** 没给 owner 时列出同名候选，用下载量排序，界面让用户挑。 */
export async function clawHubCandidates(slug: string, signal?: AbortSignal): Promise<ClawHubCandidate[]> {
  const detail = (await clawHubJson(`${clawHubOrigin()}/api/v1/skills/${encodeURIComponent(slug)}`, signal)) as { matches?: { ownerHandle: string; slug: string; url: string }[] };
  const matches = Array.isArray(detail.matches) ? detail.matches : [];
  if (matches.length === 0) throw new CustomSkillError("invalid_skill_package", `ClawHub 上找不到技能：${slug}`);
  const ranked = new Map<string, number | null>();
  try {
    const search = (await clawHubJson(`${clawHubOrigin()}/api/v1/search?q=${encodeURIComponent(slug)}&limit=20`, signal)) as { results?: { install?: { reference?: string }; downloads?: number | null }[] };
    for (const item of search.results ?? []) {
      const reference = item.install?.reference;
      if (reference) ranked.set(reference, typeof item.downloads === "number" ? item.downloads : null);
    }
  } catch { /* 排序只是锦上添花，拿不到就按原始顺序。 */ }
  return matches
    .map((match) => ({
      owner: match.ownerHandle,
      slug: match.slug,
      url: match.url,
      downloads: ranked.get(`${match.ownerHandle}/${match.slug}`) ?? null,
    }))
    .sort((a, b) => (b.downloads ?? -1) - (a.downloads ?? -1));
}

/**
 * 平台钩子目录（OpenClaw 的 `hooks/<平台>/`）只在该平台有意义，Pi 没有对应概念。
 * 其它文件一律保留——技能自带的脚本（如 `scripts/extract-skill.sh`）可能是运行所需的。
 */
export function isPlatformHookPath(path: string): boolean {
  const parts = path.split("/");
  return parts.length >= 3 && parts[0] === "hooks" && parts[1] !== "" && parts[1] !== undefined;
}

export interface ClawHubSkill {
  files: { path: string; content: Buffer }[];
  origin: CustomSkillPackage["origin"];
  /** 被跳过的平台专用文件（预览里说明，不静默丢弃）。 */
  skipped: string[];
}

/** 从 ClawHub 下载整个技能 ZIP 并解包；`owner` 缺失时先消歧，唯一候选直接用。 */
export async function fetchClawHubSkill(slug: string, owner: string | undefined, signal?: AbortSignal): Promise<ClawHubSkill> {
  let handle = owner;
  if (!handle) {
    const candidates = await clawHubCandidates(slug, signal);
    if (candidates.length === 1) handle = candidates[0]!.owner;
    else throw new CustomSkillError("skill_ambiguous", "这个地址没有写作者，ClawHub 上有多个同名技能，请在界面上选一个。");
  }
  const label = `${clawHubOrigin()}/${handle}/skills/${slug}`;
  const buffer = await download(`${clawHubOrigin()}/api/v1/download?slug=${encodeURIComponent(slug)}&ownerHandle=${encodeURIComponent(handle)}`, signal);
  const entries = unzipEntries(buffer);
  const skipped = entries.filter((file) => isPlatformHookPath(file.path)).map((file) => file.path).sort();
  const files = entries.filter((file) => !isPlatformHookPath(file.path));
  if (files.length === 0) throw new CustomSkillError("invalid_skill_package", "这个技能包里只有平台专用文件，没有可安装的内容。");
  return { files, origin: { kind: "clawhub", label: "ClawHub", url: label }, skipped };
}

/** 安全扫描结论：两个扫描器并列返回，界面不合并成一个词。 */
export async function clawHubSecurity(slug: string, owner: string, signal?: AbortSignal): Promise<ClawHubSecurity | null> {
  const raw = (await clawHubJson(`${clawHubOrigin()}/api/v1/skills/${encodeURIComponent(slug)}/scan?ownerHandle=${encodeURIComponent(owner)}`, signal)) as {
    security?: { status?: string; hasWarnings?: boolean; scanners?: Record<string, { status?: string; recommendation?: string; severity?: string; verdict?: string; confidence?: string; issueCount?: number }> };
  };
  const security = raw.security;
  if (!security) return null;
  return {
    status: String(security.status ?? "unknown"),
    hasWarnings: Boolean(security.hasWarnings),
    scanners: Object.entries(security.scanners ?? {}).map(([name, value]) => ({
      name,
      status: String(value.status ?? "unknown"),
      ...(value.recommendation ? { recommendation: value.recommendation } : {}),
      ...(value.severity ? { severity: value.severity } : {}),
      ...(value.verdict ? { verdict: value.verdict } : {}),
      ...(value.confidence ? { confidence: value.confidence } : {}),
      ...(typeof value.issueCount === "number" ? { issueCount: value.issueCount } : {}),
    })),
  };
}

interface GithubParts { owner: string; repo: string; ref?: string; subdir?: string; filePath?: string }

function githubParts(url: URL): GithubParts | undefined {
  if (!/(^|\.)github\.com$/i.test(url.hostname)) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const [owner, repo, kind, ref, ...rest] = parts as [string, string, ...string[]];
  if (!owner || !repo) return undefined;
  if (kind === "tree" && ref) return { owner, repo, ref, subdir: rest.join("/") || undefined };
  if (kind === "blob" && ref) return { owner, repo, ref, filePath: rest.join("/") };
  return { owner, repo };
}

async function fetchGithub(parts: GithubParts, url: URL, signal?: AbortSignal): Promise<UrlImport> {
  const label = url.toString();
  if (parts.filePath) {
    const raw = `https://raw.githubusercontent.com/${parts.owner}/${parts.repo}/${parts.ref}/${parts.filePath}`;
    return { files: [{ path: "SKILL.md", content: await download(raw, signal) }], origin: { kind: "url", label, url: label } };
  }
  const ref = parts.ref ?? "main";
  const archive = `https://codeload.github.com/${parts.owner}/${parts.repo}/zip/refs/heads/${ref}`;
  const files = unzipEntries(await download(archive, signal));
  if (!parts.subdir) return { files, origin: { kind: "url", label, url: label } };
  const prefix = `${parts.repo}-${ref}/${parts.subdir}/`;
  const nested = files.filter((file) => file.path.startsWith(prefix)).map((file) => ({ path: file.path.slice(prefix.length), content: file.content }));
  if (nested.length === 0) throw new CustomSkillError("skill_download_failed", `压缩包里找不到子目录：${parts.subdir}`);
  return { files: nested, origin: { kind: "url", label, url: label } };
}

/** Unzips with a bound on entries and uncompressed size, so a zip bomb fails early. */
export function unzipEntries(buffer: Buffer): { path: string; content: Buffer }[] {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(buffer));
  } catch { throw new CustomSkillError("skill_download_failed", "压缩包无法解压。"); }
  const paths = Object.keys(entries).filter((path) => !path.endsWith("/"));
  if (paths.length > MAX_SKILL_FILES * 4) throw new CustomSkillError("skill_too_large", "压缩包条目过多。");
  let total = 0;
  const files: { path: string; content: Buffer }[] = [];
  for (const path of paths) {
    const content = Buffer.from(entries[path]!);
    total += content.length;
    if (total > MAX_DOWNLOAD_BYTES) throw new CustomSkillError("skill_too_large", `压缩包解压后超过上限（${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MiB）。`);
    files.push({ path, content });
  }
  return files;
}

async function download(url: string, signal?: AbortSignal): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const onOuter = () => controller.abort();
  signal?.addEventListener("abort", onOuter, { once: true });
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new CustomSkillError("skill_download_failed", `下载失败：HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_DOWNLOAD_BYTES) throw new CustomSkillError("skill_too_large", `文件超过上限（${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MiB）。`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_DOWNLOAD_BYTES) throw new CustomSkillError("skill_too_large", `文件超过上限（${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MiB）。`);
    return buffer;
  } catch (error) {
    if (error instanceof CustomSkillError) throw error;
    throw new CustomSkillError("skill_download_failed", "下载失败，请检查网址或稍后再试。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuter);
  }
}
