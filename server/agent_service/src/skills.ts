import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadSkillsFromDir, type ResourceDiagnostic, type Skill } from "@earendil-works/pi-coding-agent";

export interface SignedSkillPackage {
  package: SkillPackage;
  tenant_id: string;
  member_id: string;
  key_id: string;
  algorithm: "Ed25519";
  signature: string;
}
export interface SkillPackage {
  skill_id: string;
  version: string;
  content_hash: string;
  display_name: string;
  description: string;
  files: SkillFile[];
}
export interface SkillFile { path: string; content: string; content_hash: string }
export interface SkillScope { tenantId: string; memberId: string }
interface SkillManifest extends SignedSkillPackage {}
interface CurrentPointer { skill_id: string; version: string; content_hash: string; tenant_id: string; member_id: string; key_id: string; algorithm: "Ed25519"; signature: string }

export class SkillVerificationError extends Error {
  constructor(message: string) { super(message); this.name = "SkillVerificationError"; }
}

function sha16(content: string): string { return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex").slice(0, 16); }
function safeSegment(value: string, name: string): void {
  if (!value || value === "." || value === ".." || /[\\/]/u.test(value) || !/^[A-Za-z0-9._-]+$/u.test(value)) throw new SkillVerificationError(`invalid ${name}`);
}
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}
function parseRef(ref: string): { skillId: string; version?: string } {
  const separator = ref.indexOf("@");
  const skillId = separator < 0 ? ref : ref.slice(0, separator);
  const version = separator < 0 ? undefined : ref.slice(separator + 1);
  safeSegment(skillId, "skill_id");
  if (version !== undefined) safeSegment(version, "version");
  return { skillId, version };
}
function canonicalPath(path: string): string {
  if (!path || path.includes("\\") || path.startsWith("/") || path.startsWith("./") || path.includes("//") || !/^[A-Za-z0-9._/-]+$/u.test(path)) throw new SkillVerificationError("non-canonical skill path");
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new SkillVerificationError("unsafe skill path");
  if (path !== "SKILL.md" && (!path.startsWith("references/") || !path.endsWith(".md"))) throw new SkillVerificationError("only SKILL.md and references/*.md are accepted");
  return path;
}
function canonicalJson(value: unknown): Buffer {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sort(child)])) : item;
  return Buffer.from(JSON.stringify(sort(value)), "utf8");
}
function packageHash(pkg: SkillPackage): string {
  const files = pkg.files.map((file) => [canonicalPath(file.path), file.content]).sort(([a], [b]) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(files), "utf8").digest("hex").slice(0, 16);
}
export function canonicalSignedSkillPackageBytes(pkg: SkillPackage, tenantId: string, memberId: string): Buffer {
  return canonicalJson({ member_id: memberId, package: pkg, tenant_id: tenantId });
}

export function verifySignedSkillPackage(value: unknown, options: { publicKey?: string; keyId?: string; tenantId?: string; memberId?: string } = {}): SignedSkillPackage {
  if (!value || typeof value !== "object") throw new SkillVerificationError("invalid signed skill package");
  const envelope = value as Record<string, unknown>;
  if (envelope.algorithm !== "Ed25519" || typeof envelope.key_id !== "string" || typeof envelope.signature !== "string" || typeof envelope.tenant_id !== "string" || typeof envelope.member_id !== "string") throw new SkillVerificationError("invalid skill signature envelope");
  if (options.keyId !== undefined && envelope.key_id !== options.keyId) throw new SkillVerificationError("skill signing key id mismatch");
  if (options.tenantId !== undefined && envelope.tenant_id !== options.tenantId) throw new SkillVerificationError("skill package tenant mismatch");
  if (options.memberId !== undefined && envelope.member_id !== options.memberId) throw new SkillVerificationError("skill package member mismatch");
  if (!options.publicKey) throw new SkillVerificationError("skill signing public key is not configured");
  const raw = envelope.package;
  if (!raw || typeof raw !== "object") throw new SkillVerificationError("unsigned skill package");
  const p = raw as Record<string, unknown>;
  if (typeof p.skill_id !== "string" || typeof p.version !== "string" || typeof p.content_hash !== "string" || typeof p.display_name !== "string" || typeof p.description !== "string" || !Array.isArray(p.files)) throw new SkillVerificationError("invalid skill package");
  safeSegment(p.skill_id, "skill_id"); safeSegment(p.version, "version");
  const seen = new Set<string>();
  for (const item of p.files) {
    if (!item || typeof item !== "object") throw new SkillVerificationError("invalid skill file");
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || typeof file.content !== "string" || typeof file.content_hash !== "string") throw new SkillVerificationError("invalid skill file");
    const path = canonicalPath(file.path);
    if (seen.has(path)) throw new SkillVerificationError("duplicate skill file path");
    seen.add(path);
    if (file.content_hash !== sha16(file.content)) throw new SkillVerificationError("skill file hash mismatch");
  }
  if (!seen.has("SKILL.md") || p.content_hash !== packageHash(p as unknown as SkillPackage)) throw new SkillVerificationError("skill package hash mismatch");
  let signature: Buffer;
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(envelope.signature) || envelope.signature.length % 4 !== 0) throw new Error("invalid base64");
    signature = Buffer.from(envelope.signature, "base64");
    if (!signature.length || signature.toString("base64") !== envelope.signature) throw new Error("invalid base64");
  } catch { throw new SkillVerificationError("invalid skill signature encoding"); }
  let publicKey;
  try { publicKey = createPublicKey({ key: Buffer.from(options.publicKey, "base64"), format: "der", type: "spki" }); } catch { throw new SkillVerificationError("invalid skill signing public key"); }
  if (!verify(null, canonicalSignedSkillPackageBytes(p as unknown as SkillPackage, envelope.tenant_id, envelope.member_id), publicKey, signature)) throw new SkillVerificationError("skill signature verification failed");
  return { package: p as unknown as SkillPackage, tenant_id: envelope.tenant_id, member_id: envelope.member_id, key_id: envelope.key_id, algorithm: "Ed25519", signature: envelope.signature };
}

export class SkillCache {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.assertNoSymlink(this.root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.assertDirectory(this.root);
  }

  reconcile(scope: SkillScope, packages: SignedSkillPackage[], allowedRefs: readonly string[], verification: { publicKey?: string; keyId?: string }, options: { authoritative?: boolean } = {}): void {
    const verified = packages.map((pkg) => verifySignedSkillPackage(pkg, { ...verification, tenantId: scope.tenantId, memberId: scope.memberId }));
    const requestedVersions = new Map<string, Set<string>>();
    const unversioned = new Set<string>();
    for (const ref of allowedRefs) {
      const parsed = parseRef(ref);
      if (parsed.version === undefined) unversioned.add(parsed.skillId);
      else (requestedVersions.get(parsed.skillId) ?? new Set<string>()).add(parsed.version);
    }
    const allowed = new Set([...unversioned, ...requestedVersions.keys()]);
    const retained = new Map<string, Set<string>>();
    const scopeRoot = this.scopeRoot(scope);
    this.assertNoSymlink(scopeRoot);
    mkdirSync(scopeRoot, { recursive: true, mode: 0o700 });
    this.assertDirectory(scopeRoot);
    this.assertTree(scopeRoot);
    for (const envelope of verified) {
      const skillId = envelope.package.skill_id;
      const versions = requestedVersions.get(skillId);
      if (!allowed.has(skillId) || (versions && !versions.has(envelope.package.version))) continue;
      this.materialize(scope, envelope, verification);
      const retainedVersions = retained.get(skillId) ?? new Set<string>();
      retainedVersions.add(envelope.package.version);
      retained.set(skillId, retainedVersions);
    }
    // An explicit non-authoritative response may add verified packages but must not
    // revoke cache entries. A verified authoritative empty response does prune.
    if (options.authoritative === false) return;
    for (const entry of readdirSync(scopeRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new SkillVerificationError("symlink in skill cache");
      if (entry.isDirectory()) {
        if (!allowed.has(entry.name)) {
          rmSync(join(scopeRoot, entry.name), { recursive: true, force: true });
          continue;
        }
        const keep = retained.get(entry.name) ?? new Set<string>();
        for (const version of readdirSync(join(scopeRoot, entry.name), { withFileTypes: true })) {
          if (version.isSymbolicLink()) throw new SkillVerificationError("symlink in skill cache");
          if (!version.isDirectory() || !keep.has(version.name)) rmSync(join(scopeRoot, entry.name, version.name), { recursive: true, force: true });
        }
      } else if (entry.isFile() && entry.name.endsWith(".json") && !allowed.has(entry.name.slice(0, -".json".length))) {
        rmSync(join(scopeRoot, entry.name), { force: true });
      }
    }
    for (const skillId of allowed) {
      const pointerPath = join(scopeRoot, `${skillId}.json`);
      if (!existsSync(pointerPath)) continue;
      const pointerVersion = this.readCurrent(scope, skillId, verification);
      if (!pointerVersion || !retained.get(skillId)?.has(pointerVersion)) rmSync(pointerPath, { force: true });
    }
  }

  pathsFor(scope: SkillScope, refs: readonly string[], verification: { publicKey?: string; keyId?: string }): string[] {
    const scopeRoot = this.scopeRoot(scope);
    if (!existsSync(scopeRoot)) return [];
    this.assertDirectory(scopeRoot);
    this.assertTree(scopeRoot);
    const paths: string[] = [];
    for (const ref of refs) {
      const { skillId, version: requested } = parseRef(ref);
      const skillRoot = join(scopeRoot, skillId);
      if (!contained(scopeRoot, skillRoot) || !existsSync(skillRoot)) continue;
      this.assertDirectory(skillRoot);
      const version = requested ?? this.readCurrent(scope, skillId, verification);
      if (!version) continue;
      safeSegment(version, "version");
      const path = join(skillRoot, version);
      if (!contained(skillRoot, path)) continue;
      if (this.validCacheRoot(path, scope, verification, skillId, version)) paths.push(path);
    }
    return paths;
  }

  private materialize(scope: SkillScope, envelope: SignedSkillPackage, verification: { publicKey?: string; keyId?: string }): void {
    const pkg = envelope.package;
    safeSegment(pkg.skill_id, "skill_id"); safeSegment(pkg.version, "version");
    const parent = this.scopeRoot(scope);
    const target = join(parent, pkg.skill_id, pkg.version);
    this.assertNoSymlink(dirname(target));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    this.assertDirectory(dirname(target));
    if (existsSync(target) && this.validMaterialized(target, scope, envelope, verification)) {
      this.writeCurrent(parent, envelope);
      return;
    }
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    const temp = join(dirname(target), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(temp, { recursive: true, mode: 0o700 });
    try {
      for (const file of pkg.files) {
        const path = canonicalPath(file.path);
        const output = join(temp, ...path.split("/"));
        mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
        writeFileSync(output, file.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      }
      writeFileSync(join(temp, ".aiteam-manifest.json"), JSON.stringify(envelope), { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temp, target);
      this.writeCurrent(parent, envelope);
    } catch (error) { rmSync(temp, { recursive: true, force: true }); throw error; }
  }

  private writeCurrent(parent: string, envelope: SignedSkillPackage): void {
    this.assertNoSymlink(parent);
    const pointer: CurrentPointer = { skill_id: envelope.package.skill_id, version: envelope.package.version, content_hash: envelope.package.content_hash, tenant_id: envelope.tenant_id, member_id: envelope.member_id, key_id: envelope.key_id, algorithm: envelope.algorithm, signature: envelope.signature };
    const path = join(parent, `${envelope.package.skill_id}.json`);
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temp, JSON.stringify(pointer), { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  }

  private readCurrent(scope: SkillScope, skillId: string, verification: { publicKey?: string; keyId?: string }): string | undefined {
    const path = join(this.scopeRoot(scope), `${skillId}.json`);
    this.assertNoSymlink(path);
    try {
      const pointer = JSON.parse(readFileSync(path, "utf8")) as CurrentPointer;
      safeSegment(pointer.version, "version");
      if (pointer.skill_id !== skillId || !pointer.content_hash) throw new Error("invalid current pointer");
      const pkg = this.manifestPackage(scope, skillId, pointer.version);
      if (pkg.skill_id !== skillId || pkg.version !== pointer.version || pkg.content_hash !== pointer.content_hash) throw new Error("stale current pointer");
      verifySignedSkillPackage({ package: pkg, ...pointer }, { ...verification, tenantId: scope.tenantId, memberId: scope.memberId });
      return pointer.version;
    } catch { return undefined; }
  }

  private manifestPackage(scope: SkillScope, skillId: string, version: string): SkillPackage {
    const path = join(this.scopeRoot(scope), skillId, version, ".aiteam-manifest.json");
    this.assertNoSymlink(path);
    const manifest = JSON.parse(readFileSync(path, "utf8")) as SkillManifest;
    return manifest.package;
  }

  private validCacheRoot(root: string, scope: SkillScope, verification: { publicKey?: string; keyId?: string }, expectedSkillId?: string, expectedVersion?: string): boolean {
    try {
      const scopeRoot = this.scopeRoot(scope);
      if (!contained(scopeRoot, root)) return false;
      if (expectedSkillId !== undefined) safeSegment(expectedSkillId, "skill_id");
      if (expectedVersion !== undefined) safeSegment(expectedVersion, "version");
      this.assertDirectory(root);
      const manifest = JSON.parse(readFileSync(join(root, ".aiteam-manifest.json"), "utf8")) as SkillManifest;
      if (expectedSkillId !== undefined && manifest.package.skill_id !== expectedSkillId) return false;
      if (expectedVersion !== undefined && manifest.package.version !== expectedVersion) return false;
      verifySignedSkillPackage(manifest, { ...verification, tenantId: scope.tenantId, memberId: scope.memberId });
      this.assertTree(root, new Set([".aiteam-manifest.json", ...manifest.package.files.map((file) => file.path)]));
      for (const file of manifest.package.files) {
        const path = join(root, ...canonicalPath(file.path).split("/"));
        const info = lstatSync(path);
        if (!info.isFile() || sha16(readFileSync(path, "utf8")) !== file.content_hash) return false;
      }
      return true;
    } catch { return false; }
  }

  private validMaterialized(root: string, scope: SkillScope, envelope: SignedSkillPackage, verification: { publicKey?: string; keyId?: string }): boolean {
    try {
      const manifest = JSON.parse(readFileSync(join(root, ".aiteam-manifest.json"), "utf8")) as SkillManifest;
      verifySignedSkillPackage(manifest, { ...verification, tenantId: scope.tenantId, memberId: scope.memberId });
      return manifest.signature === envelope.signature && manifest.package.skill_id === envelope.package.skill_id && manifest.package.version === envelope.package.version && manifest.package.content_hash === envelope.package.content_hash && this.validCacheRoot(root, scope, verification, envelope.package.skill_id, envelope.package.version);
    } catch { return false; }
  }

  private assertTree(root: string, expected?: Set<string>, base = root): void {
    this.assertNoSymlink(root);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new SkillVerificationError("symlink in skill cache");
      const path = join(root, entry.name);
      if (entry.isDirectory()) this.assertTree(path, expected, base);
      else if (expected && !expected.has(relative(base, path).split(sep).join("/"))) throw new SkillVerificationError("unexpected file in skill cache");
    }
  }

  private scopeRoot(scope: SkillScope): string {
    safeSegment(scope.tenantId, "tenant_id"); safeSegment(scope.memberId, "member_id");
    this.assertNoSymlink(this.root);
    const path = join(this.root, scope.tenantId, scope.memberId);
    const rel = relative(this.root, path);
    if (rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(sep)) throw new SkillVerificationError("skill cache path escapes root");
    this.assertNoSymlink(path);
    return path;
  }
  private assertNoSymlink(path: string): void {
    const absolute = resolve(path);
    let current = resolve(sep);
    for (const part of relative(resolve(sep), absolute).split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        if (lstatSync(current).isSymbolicLink()) throw new SkillVerificationError("symlink in skill cache path");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }
  private assertDirectory(path: string): void {
    this.assertNoSymlink(path);
    const info = lstatSync(path);
    if (!info.isDirectory()) throw new SkillVerificationError("unsafe skill cache path");
  }
}

export function skillRefsForSnapshot(snapshot: { skill_refs?: unknown; skills?: unknown }): string[] {
  const refs = snapshot.skill_refs ?? snapshot.skills;
  return Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === "string" && ref.length > 0) : [];
}

export function skillResourcePaths(cache: SkillCache, scope: SkillScope, refs: readonly string[], verification: { publicKey?: string; keyId?: string }): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
  const skills: Skill[] = []; const diagnostics: ResourceDiagnostic[] = [];
  for (const path of cache.pathsFor(scope, refs, verification)) {
    const result = loadSkillsFromDir({ dir: path, source: "aiteam-manager" });
    skills.push(...result.skills); diagnostics.push(...result.diagnostics);
  }
  return { skills, diagnostics };
}
