#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_ROOT = join(ROOT, "server", "agent_service");
const WEB_ROOT = join(ROOT, "web");
const CONFIG_TEMPLATE = join(ROOT, "deploy", "agent", "config", "agent.env.example");
const DEFAULT_NODE_VERSION = "22.19.0";
const TARGETS = {
  "darwin-arm64": { nodeTarget: "darwin-arm64", archive: "tar.gz", runtimeName: "node" },
  "darwin-x64": { nodeTarget: "darwin-x64", archive: "tar.gz", runtimeName: "node" },
  "win32-arm64": { nodeTarget: "win-arm64", archive: "zip", runtimeName: "node.exe" },
  "win32-x64": { nodeTarget: "win-x64", archive: "zip", runtimeName: "node.exe" },
};

const FORBIDDEN_CHILD_ENV = new Set([
  "AITEAM_CONSOLE_CREDENTIALS_FILE", "MANAGER_CREDENTIAL_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_KEYFILE_JSON", "AWS_SHARED_CREDENTIALS_FILE", "AWS_PROFILE", "AZURE_CONFIG_DIR", "CLOUDSDK_CONFIG", "BOTO_CONFIG", "KUBECONFIG", "DOCKER_AUTH_CONFIG", "GIT_ASKPASS", "SSH_AUTH_SOCK", "NPM_CONFIG_USERCONFIG", "DB_URL", "ADMIN_DB_URL",
  "DATABASE_URL", "DATABASE_URI", "DATABASE_DSN", "DATABASE_CONNECTION_STRING", "TEST_DATABASE_URL",
  "DSN", "SQL_DSN", "CONNECTION_STRING", "DB_URI", "DB_DSN", "DB_CONNECTION_STRING", "REDIS_URL",
  "REDIS_URI", "REDIS_DSN", "REDIS_CONNECTION_STRING", "MYSQL_URL", "MYSQL_URI", "MYSQL_DSN",
  "MYSQL_CONNECTION_STRING", "MONGO_URL", "MONGO_URI", "MONGO_DSN", "MONGO_CONNECTION_STRING",
  "POSTGRES_URL", "POSTGRES_URI", "POSTGRES_DSN", "POSTGRES_CONNECTION_STRING", "REDIS_CONN_STRING",
  "PROVIDER_URL", "PROVIDER_URI", "PROVIDER_API_KEY", "PROVIDER_TOKEN", "PROVIDER_SECRET",
  "MODEL_PRICING_URL", "NEWAPI_BASE_URL", "NEWAPI_PUBLIC_BASE_URL", "NEWAPI_API_KEY", "NEWAPI_TOKEN", "OPERATION_URL",
  "OPERATION_API_KEY", "OPERATOR_URL", "AITEAM_OPERATOR_URL", "MANAGER_BASE_URL", "MANAGER_API_KEY", "API_KEY", "PASSWORD", "PASSWD",
  "DB_PASSWORD", "DATABASE_PASSWORD", "REDIS_PASSWORD", "MYSQL_PASSWORD", "MONGO_PASSWORD",
  "NEWAPI_PASSWORD", "SERVICE_PASSWORD", "PROVIDER_PASSWORD", "HINDSIGHT_PASSWORD", "LIGHTRAG_PASSWORD",
  "OAUTH_GOOGLE_CLIENT_SECRET", "OAUTH_GITHUB_CLIENT_SECRET", "LOGIN_AUDIT_PEPPER", "SESSION_SECRET",
  "CRYPTO_SECRET", "APP_RW_PASSWORD", "POSTGRES_PASSWORD", "POSTGRES_SUPER_PASSWORD", "SERVICE_TOKEN",
  "SERVICE_SECRET", "SERVICE_API_KEY", "SERVICE_APIKEY", "NEWAPI_ADMIN_USERNAME", "NEWAPI_ADMIN_PASSWORD",
  "NEWAPI_ADMIN_USER_ID", "NEWAPI_ADMIN_TOKEN", "NEWAPI_DB_PASSWORD", "NEWAPI_REDIS_PASSWORD",
  "NEWAPI_SESSION_SECRET", "NEWAPI_CRYPTO_SECRET", "OPERATION_SYSTEM_USERNAME", "OPERATION_SYSTEM_PASSWORD",
  "OPERATION_SIGNING_PRIVATE_KEY", "OPERATION_PROVIDER_CREDENTIAL_KEY", "LIGHTRAG_INSTANCES",
  "LIGHTRAG_AUTH_ACCOUNTS", "LIGHTRAG_TOKEN_SECRET", "LIGHTRAG_API_KEY", "LIGHTRAG_URL", "LIGHTRAG_WORKSPACE",
  "AITEAM_HINDSIGHT_URL", "HINDSIGHT_URL", "HINDSIGHT_BASE_URL", "HINDSIGHT_FACADE_URL",
  "HINDSIGHT_CP_ACCESS_KEY", "HINDSIGHT_API_TOKEN", "HINDSIGHT_API_KEY", "HINDSIGHT_API_KEY_REF",
  "AUTH_ACCOUNTS", "TOKEN_SECRET", "AITEAM_SKILL_SIGNING_PRIVATE_KEY", "AITEAM_SKILL_SIGNING_CURRENT_PRIVATE_KEY",
  "AITEAM_SKILL_SIGNING_NEXT_PRIVATE_KEY",
]);
const SAFE_AGENT_URLS = new Set(["AITEAM_MANAGER_URL", "AITEAM_RAG_MCP_URL", "AITEAM_AGENT_JWKS_PATH", "AITEAM_CONFIG_FILE"]);

function isForbiddenChildEnvironmentName(name) {
  const upper = name.toUpperCase();
  if (upper === "PATH" || SAFE_AGENT_URLS.has(upper)) return false;
  if (FORBIDDEN_CHILD_ENV.has(upper)) return true;
  if (/(?:^|_)(?:API_KEY|APIKEY|PASSWORD|PASSWD|TOKEN|SECRET|SECRET_KEY|ENCRYPTION_KEY|MASTER_KEY|PEPPER|PRIVATE_KEY|ACCESS_KEY|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|CREDENTIAL|CREDENTIALS|CREDENTIAL_PATH|CREDENTIALS_FILE|CREDENTIAL_FILE|KEY_FILE|KEYFILE)$/u.test(upper)) return true;
  if (/(?:^|_)(?:URL|URI|DSN|CONNECTION_STRING|KEY_PATH|PATH)$/u.test(upper)) return true;
  return false;
}

function childEnvironment(extra = {}) {
  // Package/build helpers receive only the platform essentials. Do not rely on
  // a denylist to scrub an ever-growing ambient CI/operator environment.
  const env = {};
  for (const key of ["PATH", "HOME", "USER", "TMPDIR", "TMP", "TEMP", "COREPACK_HOME", "SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, extra);
  for (const key of Object.keys(env)) {
    if (isForbiddenChildEnvironmentName(key)) delete env[key];
  }
  return env;
}

await main().catch((error) => {
  console.error(`[agent-package][ERR] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const hostTarget = `${process.platform}-${process.arch}`;
  const target = options.target ?? hostTarget;
  const targetSpec = TARGETS[target];
  if (!targetSpec) throw new Error(`unsupported target ${target}; use ${Object.keys(TARGETS).join(", ")}`);
  if (target !== hostTarget) {
    throw new Error(`build on the target OS/architecture (host=${hostTarget}, target=${target}); native optional dependencies are not cross-build safe`);
  }
  if (!existsSync(CONFIG_TEMPLATE)) throw new Error(`missing config template: ${CONFIG_TEMPLATE}`);

  const sourcePackage = JSON.parse(readFileSync(join(AGENT_ROOT, "package.json"), "utf8"));
  const version = options.version ?? sourcePackage.version;
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/u.test(version)) throw new Error(`invalid package version: ${version}`);
  const outputRoot = resolve(options.out ?? join(ROOT, "dist", "agent-packages"));
  const packageName = `aiteam-agent-${version}-${target}`;
  const packageRoot = join(outputRoot, packageName);
  const archivePath = join(outputRoot, `${packageName}.${targetSpec.archive}`);

  mkdirSync(outputRoot, { recursive: true });
  rmSync(packageRoot, { recursive: true, force: true });
  rmSync(archivePath, { force: true });

  if (!options.skipBuild) {
    rmSync(join(AGENT_ROOT, "dist"), { recursive: true, force: true });
    run("pnpm", ["install", "--frozen-lockfile"], AGENT_ROOT);
    run("pnpm", ["install", "--frozen-lockfile"], WEB_ROOT);
    run("pnpm", ["--filter", "@aiteam/shared", "run", "build"], WEB_ROOT);
    run("pnpm", ["--filter", "@aiteam/agent", "run", "build"], WEB_ROOT);
    run("pnpm", ["run", "build:runtime"], AGENT_ROOT);
  }

  for (const path of [join(AGENT_ROOT, "dist", "main.js"), join(WEB_ROOT, "agent", "dist", "index.html")]) {
    if (!existsSync(path)) throw new Error(`build output is missing: ${path}`);
  }

  mkdirSync(packageRoot, { recursive: true });
  cpSync(join(AGENT_ROOT, "dist"), join(packageRoot, "dist"), { recursive: true });
  cpSync(join(AGENT_ROOT, "bin"), join(packageRoot, "bin"), { recursive: true });
  cpSync(join(WEB_ROOT, "agent", "dist"), join(packageRoot, "web", "agent", "dist"), { recursive: true });
  cpSync(join(ROOT, "deploy", "agent", "README.md"), join(packageRoot, "README.md"));
  cpSync(join(ROOT, "deploy", "agent", "CLIENT-INTEGRATION.md"), join(packageRoot, "CLIENT-INTEGRATION.md"));
  if (process.platform !== "win32") execFileSync("chmod", ["755", join(packageRoot, "bin", "start-agent.sh")], { env: childEnvironment() });
  mkdirSync(join(packageRoot, "config"), { recursive: true });

  const config = prepareConfig(options);
  materializeJwks(config, packageRoot);
  if (config.values.AITEAM_AGENT_JWKS_JSON?.trim()) {
    config.text = setEnvValue(config.text, "AITEAM_AGENT_JWKS_JSON", JSON.stringify(validateJwks(config.values.AITEAM_AGENT_JWKS_JSON)));
    config.values = parseEnv(config.text, config.source);
  }
  validateConfigForPackage(config.values, options.config !== undefined);
  writeFileSync(join(packageRoot, "config", "agent.env"), config.text, { mode: 0o600 });
  cpSync(CONFIG_TEMPLATE, join(packageRoot, "config", "agent.env.example"));

  const packaged = { ...sourcePackage, version, private: false, files: ["dist", "bin", "config", "web", "README.md", "CLIENT-INTEGRATION.md"] };
  writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify(packaged, null, 2)}\n`);
  cpSync(join(AGENT_ROOT, "pnpm-lock.yaml"), join(packageRoot, "pnpm-lock.yaml"));
  cpSync(join(AGENT_ROOT, "pnpm-workspace.yaml"), join(packageRoot, "pnpm-workspace.yaml"));

  run("pnpm", ["install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--config.node-linker=hoisted"], packageRoot);
  removeNodeBinDirs(join(packageRoot, "node_modules"));
  rmSync(join(packageRoot, "node_modules", ".pnpm"), { recursive: true, force: true });
  rmSync(join(packageRoot, "node_modules", ".pnpm-workspace-state-v1.json"), { force: true });
  rmSync(join(packageRoot, "node_modules", ".modules.yaml"), { force: true });
  rmSync(join(packageRoot, "pnpm-lock.yaml"), { force: true });
  rmSync(join(packageRoot, "pnpm-workspace.yaml"), { force: true });

  const runtime = await installNodeRuntime(packageRoot, targetSpec, options.nodeVersion, options.nodeRuntime);
  verifyDependencyImports(runtime, packageRoot);
  assertNoControlPlaneFiles(packageRoot);

  const files = collectFiles(packageRoot).filter((entry) => entry.path !== "manifest.json");
  const manifest = {
    schema_version: 1,
    product: "aiteam-agent",
    version,
    target,
    node_version: runtime.version,
    configured: config.configured,
    config_source: config.source,
    files,
  };
  writeFileSync(join(packageRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  createArchive(packageRoot, archivePath, targetSpec.archive);

  console.log(`[agent-package] directory: ${packageRoot}`);
  console.log(`[agent-package] archive:   ${archivePath}`);
  console.log(`[agent-package] target:    ${target}`);
  console.log(`[agent-package] configured: ${config.configured ? "yes" : "template only (fill config/agent.env before launch)"}`);
}

function parseArgs(args) {
  const result = { nodeVersion: DEFAULT_NODE_VERSION };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const equals = argument.indexOf("=");
    const name = equals < 0 ? argument : argument.slice(0, equals);
    const inline = equals < 0 ? undefined : argument.slice(equals + 1);
    const takesValue = !["--skip-build", "--help"].includes(name);
    const value = inline ?? (takesValue ? args[++index] : undefined);
    switch (name) {
      case "--target": result.target = required(name, value); break;
      case "--version": result.version = required(name, value); break;
      case "--out": result.out = required(name, value); break;
      case "--config": result.config = resolve(required(name, value)); break;
      case "--manager-url": result.managerUrl = required(name, value); break;
      case "--node-version": result.nodeVersion = required(name, value); break;
      case "--node-runtime": result.nodeRuntime = resolve(required(name, value)); break;
      case "--skip-build": result.skipBuild = true; break;
      case "--help": result.help = true; break;
      default: throw new Error(`unknown option ${argument}`);
    }
  }
  return result;
}

function required(name, value) {
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Build a self-contained Agent sidecar for the current OS/architecture.\n\nUsage:\n  node scripts/build-agent-package.mjs [options]\n\nOptions:\n  --target <target>       darwin-arm64, darwin-x64, win32-arm64, win32-x64\n  --config <file>         production/test agent.env; validated and copied into package\n  --manager-url <url>     fill the template Manager URL (config mode is preferred)\n  --version <version>     artifact version (defaults to server/agent_service package version)\n  --node-version <ver>    Node runtime to download (default: ${DEFAULT_NODE_VERSION})\n  --node-runtime <path>   use a local target Node binary instead of downloading\n  --out <directory>       output directory (default: dist/agent-packages)\n  --skip-build             reuse existing web/agent and Agent runtime build output\n`);
}

function prepareConfig(options) {
  const source = options.config ? options.config : CONFIG_TEMPLATE;
  let text = readFileSync(source, "utf8");
  if (options.managerUrl && !options.config) {
    let parsed;
    try { parsed = new URL(options.managerUrl); } catch { throw new Error("--manager-url must be an absolute HTTP(S) URL without embedded credentials"); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("--manager-url must be an absolute HTTP(S) URL without embedded credentials");
    text = setEnvValue(text, "AITEAM_MANAGER_URL", options.managerUrl);
  }
  return { text, values: parseEnv(text, source), configured: options.config !== undefined, source: options.config ? "provided" : "template", configPath: source };
}

function materializeJwks(config, packageRoot) {
  const configuredPath = config.values.AITEAM_AGENT_JWKS_PATH?.trim();
  if (!configuredPath) return;
  const sourcePath = isAbsolute(configuredPath) ? configuredPath : resolve(dirname(config.configPath), configuredPath);
  if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) throw new Error(`AITEAM_AGENT_JWKS_PATH is not a readable file: ${sourcePath}`);
  const filename = "manager-jwks.json";
  const content = readFileSync(sourcePath, "utf8");
  const publicJwks = validateJwks(content);
  writeFileSync(join(packageRoot, "config", filename), JSON.stringify(publicJwks), { mode: 0o600 });
  config.text = setEnvValue(config.text, "AITEAM_AGENT_JWKS_PATH", filename);
  config.values = parseEnv(config.text, config.source);
}

function parseEnv(text, source) {
  const values = {};
  for (const [index, original] of text.split(/\r?\n/u).entries()) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = assignment.indexOf("=");
    if (separator <= 0) throw new Error(`${source}:${index + 1} must contain KEY=VALUE`);
    const key = assignment.slice(0, separator).trim();
    if (Object.hasOwn(values, key)) throw new Error(`${source}:${index + 1} defines ${key} more than once`);
    values[key] = parseBuildValue(assignment.slice(separator + 1).trim(), source, index + 1);
  }
  return values;
}

function parseBuildValue(value, source, line) {
  if (!value) return "";
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return value;
  if (value.length < 2 || value.at(-1) !== quote) throw new Error(`${source}:${line} has an unterminated quoted value`);
  const inner = value.slice(1, -1);
  return quote === "'" ? inner : inner.replaceAll(/\\([\\"nrt])/gu, (_match, escaped) => ({ "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" }[escaped] ?? escaped));
}

function setEnvValue(text, key, value) {
  const encoded = /[\s#"']/u.test(value) ? JSON.stringify(value) : value;
  const pattern = new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=).*$`, "mu");
  return pattern.test(text) ? text.replace(pattern, `$1${encoded}`) : `${text.trimEnd()}\n${key}=${encoded}\n`;
}

function validateConfigForPackage(values, strict) {
  const forbidden = Object.keys(values).filter((key) => isForbiddenChildEnvironmentName(key) && values[key].trim() !== "");
  if (forbidden.length) throw new Error(`Agent package config contains control-plane/upstream secret settings: ${forbidden.join(", ")}`);
  if (values.AITEAM_AGENT_JWKS_JSON?.trim() && values.AITEAM_AGENT_JWKS_PATH?.trim()) throw new Error("Agent JWT config must set exactly one of AITEAM_AGENT_JWKS_JSON or AITEAM_AGENT_JWKS_PATH");
  if (!strict) return;

  const environment = values.AITEAM_ENV;
  if (environment !== "production" && environment !== "test") throw new Error("packaged Agent config must set AITEAM_ENV=production or test");
  if (!values.AITEAM_MANAGER_URL?.trim()) throw new Error("packaged Agent config requires AITEAM_MANAGER_URL");
  const managerUrl = new URL(values.AITEAM_MANAGER_URL);
  if ((managerUrl.protocol !== "https:" && managerUrl.protocol !== "http:") || managerUrl.username || managerUrl.password || managerUrl.search || managerUrl.hash) throw new Error("AITEAM_MANAGER_URL must be an HTTP(S) URL without embedded credentials");
  if (environment === "production" && managerUrl.protocol !== "https:") throw new Error("AITEAM_MANAGER_URL must use HTTPS in a production package");
  const devAuth = values.AITEAM_AGENT_DEV_AUTH?.toLowerCase() === "true";
  if (environment === "production" && devAuth) throw new Error("AITEAM_AGENT_DEV_AUTH=true is forbidden in a production package");
  if (!devAuth) {
    for (const name of ["AITEAM_AGENT_JWT_ISSUER", "AITEAM_AGENT_JWT_AUDIENCE"]) {
      if (!values[name]?.trim()) throw new Error(`packaged Agent config requires ${name} when development auth is disabled`);
    }
    const issuer = new URL(values.AITEAM_AGENT_JWT_ISSUER);
    if ((issuer.protocol !== "https:" && issuer.protocol !== "http:") || issuer.username || issuer.password || issuer.search || issuer.hash || (environment === "production" && issuer.protocol !== "https:")) throw new Error("AITEAM_AGENT_JWT_ISSUER must be an HTTP(S) URL without credentials");
    if (environment === "production" && values.AITEAM_AGENT_JWT_ISSUER.trim() !== values.AITEAM_MANAGER_URL.trim()) throw new Error("AITEAM_AGENT_JWT_ISSUER must exactly match AITEAM_MANAGER_URL in production");
    if (!values.AITEAM_AGENT_JWKS_JSON?.trim() && !values.AITEAM_AGENT_JWKS_PATH?.trim()) throw new Error("packaged Agent config requires AITEAM_AGENT_JWKS_JSON or AITEAM_AGENT_JWKS_PATH");
  }
  if (values.AITEAM_AGENT_JWKS_JSON?.includes('"d"') || values.AITEAM_AGENT_JWKS_JSON?.includes("BEGIN PRIVATE KEY")) throw new Error("Agent config must contain public JWKS only");
  if (values.AITEAM_AGENT_JWKS_JSON?.trim()) validateJwks(values.AITEAM_AGENT_JWKS_JSON);
  if (environment === "production" && !values.AITEAM_SKILL_SIGNING_PUBLIC_KEY?.trim() && !values.AITEAM_SKILL_SIGNING_PUBLIC_KEYS?.trim()) throw new Error("packaged Agent config requires public Skill signing key metadata");
  if (values.AITEAM_SKILL_SIGNING_PUBLIC_KEY?.trim() && !values.AITEAM_SKILL_SIGNING_KEY_ID?.trim()) throw new Error("AITEAM_SKILL_SIGNING_KEY_ID is required with AITEAM_SKILL_SIGNING_PUBLIC_KEY");
  if (values.AITEAM_SKILL_SIGNING_PUBLIC_KEY?.trim()) {
    try { createPublicKey({ key: Buffer.from(values.AITEAM_SKILL_SIGNING_PUBLIC_KEY, "base64"), format: "der", type: "spki" }); } catch { throw new Error("AITEAM_SKILL_SIGNING_PUBLIC_KEY must be a base64 Ed25519 public key"); }
  }
  if (!values.AITEAM_SKILL_SIGNING_PUBLIC_KEY?.trim() && values.AITEAM_SKILL_SIGNING_PUBLIC_KEYS?.trim()) validateSkillKeys(values.AITEAM_SKILL_SIGNING_PUBLIC_KEYS);
  if (values.AITEAM_AGENT_SANDBOX_READY?.toLowerCase() !== "true") throw new Error("packaged Agent config requires AITEAM_AGENT_SANDBOX_READY=true");
  if (values.AITEAM_AGENT_LOCAL_ONLY?.toLowerCase() !== "true") throw new Error("packaged Agent config requires AITEAM_AGENT_LOCAL_ONLY=true");
  if (values.HOST && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(values.HOST.trim().toLowerCase())) throw new Error("packaged Agent config HOST must be loopback");
  if (values.AITEAM_AGENT_ALLOWED_ORIGINS?.split(",").some((origin) => origin.trim() === "*")) throw new Error("wildcard CORS origins are not allowed");
  for (const name of ["AITEAM_AGENT_DATA_DIR", "AITEAM_AGENT_SPA_ROOT", "AITEAM_AGENT_PORT_FILE"]) {
    if (values[name]?.trim()) throw new Error(`${name} must be supplied by the client launcher, not baked into a portable package`);
  }
}

function validateJwks(value) {
  let document;
  try { document = JSON.parse(value); } catch { throw new Error("AITEAM_AGENT_JWKS_JSON must be valid JSON"); }
  if (!document || typeof document !== "object" || Array.isArray(document) || Object.keys(document).some((name) => name !== "keys") || !Array.isArray(document.keys) || document.keys.length === 0) throw new Error("AITEAM_AGENT_JWKS_JSON must contain only the keys member and at least one key");
  const allowedMembers = new Set(["kty", "alg", "kid", "n", "e", "use"]);
  const privateMembers = ["d", "p", "q", "dp", "dq", "qi", "oth"];
  const seenKids = new Set();
  const publicKeys = document.keys.map((key) => {
    if (!key || typeof key !== "object" || Array.isArray(key) || Object.keys(key).some((member) => !allowedMembers.has(member)) || privateMembers.some((member) => Object.hasOwn(key, member))) throw new Error("AITEAM_AGENT_JWKS_JSON must contain only RSA RS256 public keys");
    if (key.kty !== "RSA" || key.alg !== "RS256" || (key.use !== undefined && key.use !== "sig") || typeof key.kid !== "string" || !key.kid.trim() || typeof key.n !== "string" || !key.n || typeof key.e !== "string" || !key.e) throw new Error("AITEAM_AGENT_JWKS_JSON must contain RSA RS256 public keys");
    if (seenKids.has(key.kid)) throw new Error("AITEAM_AGENT_JWKS_JSON must not contain duplicate kid values");
    seenKids.add(key.kid);
    try { createPublicKey({ key, format: "jwk" }); } catch { throw new Error(`AITEAM_AGENT_JWKS_JSON contains an invalid RSA key: ${key.kid}`); }
    return { kty: "RSA", alg: "RS256", kid: key.kid, n: key.n, e: key.e, ...(key.use === undefined ? {} : { use: "sig" }) };
  });
  return { keys: publicKeys };
}

function validateSkillKeys(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error("AITEAM_SKILL_SIGNING_PUBLIC_KEYS must be valid JSON metadata"); }
  const keys = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.keys) ? parsed.keys : undefined;
  if (!keys?.length || keys.some((key) => !key || typeof key.key_id !== "string" || key.algorithm !== "Ed25519" || typeof key.public_key !== "string" || !["current", "next", "revoked", "expired"].includes(key.status))) throw new Error("AITEAM_SKILL_SIGNING_PUBLIC_KEYS must contain public Ed25519 metadata");
}

async function installNodeRuntime(packageRoot, spec, requestedVersion, providedPath) {
  const source = providedPath ?? await downloadNodeRuntime(spec.nodeTarget, spec.archive, requestedVersion);
  if (!existsSync(source) || !lstatSync(source).isFile()) throw new Error(`Node runtime is not a regular file: ${source}`);
  const version = execFileSync(source, ["--version"], { encoding: "utf8", env: childEnvironment() }).trim().replace(/^v/u, "");
  if (!/^22\./u.test(version)) throw new Error(`Node runtime ${version} is unsupported; Agent requires Node 22`);
  const destination = join(packageRoot, "runtime", spec.runtimeName);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
  if (process.platform !== "win32") execFileSync("chmod", ["755", destination], { env: childEnvironment() });
  return { path: destination, version };
}

async function downloadNodeRuntime(nodeTarget, archiveType, version) {
  const filename = `node-v${version}-${nodeTarget}.${archiveType}`;
  const cacheRoot = process.env.AITEAM_AGENT_CACHE_DIR
    ? resolve(process.env.AITEAM_AGENT_CACHE_DIR)
    : process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "aiteam-agent", "cache")
      : join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "aiteam-agent");
  const archive = join(cacheRoot, filename);
  mkdirSync(cacheRoot, { recursive: true });
  const base = `https://nodejs.org/dist/v${version}`;
  const sumsResponse = await fetch(`${base}/SHASUMS256.txt`);
  if (!sumsResponse.ok) throw new Error(`failed to download Node checksums: HTTP ${sumsResponse.status}`);
  const sums = await sumsResponse.text();
  const expected = sums.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u)).find((parts) => parts[1] === filename)?.[0];
  if (!expected) throw new Error(`Node checksum is missing for ${filename}`);
  if (existsSync(archive)) {
    const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
    if (actual !== expected) rmSync(archive, { force: true });
  }
  if (!existsSync(archive)) {
    const archiveResponse = await fetch(`${base}/${filename}`);
    if (!archiveResponse.ok) throw new Error(`failed to download ${filename}: HTTP ${archiveResponse.status}`);
    const bytes = Buffer.from(await archiveResponse.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) throw new Error(`Node checksum mismatch for ${filename}`);
    writeFileSync(archive, bytes, { mode: 0o600 });
  }

  const extracted = mkdtempSync(join(tmpdir(), "aiteam-node-"));
  try {
    if (archiveType === "tar.gz") execFileSync("tar", ["-xzf", archive, "-C", extracted], { env: childEnvironment() });
    else execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $env:AITEAM_NODE_ARCHIVE -DestinationPath $env:AITEAM_NODE_EXTRACT -Force"], { env: childEnvironment({ AITEAM_NODE_ARCHIVE: archive, AITEAM_NODE_EXTRACT: extracted }) });
    const root = readdirSync(extracted, { withFileTypes: true }).find((entry) => entry.isDirectory());
    if (!root) throw new Error(`Node archive ${filename} has no top-level directory`);
    const binary = archiveType === "zip" ? join(extracted, root.name, "node.exe") : join(extracted, root.name, "bin", "node");
    if (!existsSync(binary)) throw new Error(`Node archive ${filename} has no runtime binary`);
    const cachedBinary = join(cacheRoot, `${filename}.runtime`);
    cpSync(binary, cachedBinary);
    if (process.platform !== "win32") execFileSync("chmod", ["755", cachedBinary], { env: childEnvironment() });
    return cachedBinary;
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
}

function removeNodeBinDirs(root) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    if (entry.name === ".bin") rmSync(path, { recursive: true, force: true });
    else removeNodeBinDirs(path);
  }
}

function verifyDependencyImports(runtime, packageRoot) {
  execFileSync(runtime.path, ["--import", "tsx/esm", "--input-type=module", "-e", "await import('fastify'); await import('@earendil-works/pi-coding-agent'); await import('@deepseek-ai/dsh-sandbox-local'); await import('./dist/pi/resources.js');"], { cwd: packageRoot, stdio: "ignore", env: childEnvironment() });
}

function assertNoControlPlaneFiles(packageRoot) {
  const forbidden = ["server", "operation_service", "manager_service", "web/operation", "web/manager", "app"];
  for (const path of forbidden) if (existsSync(join(packageRoot, path))) throw new Error(`Agent package contains forbidden control-plane path: ${path}`);
  if (!existsSync(join(packageRoot, "web", "agent", "dist", "index.html"))) throw new Error("Agent package is missing the Agent SPA");
}

function collectFiles(root, current = root) {
  const entries = [];
  for (const name of readdirSync(current)) {
    const absolute = join(current, name);
    const relativePath = relative(root, absolute).split(sep).join("/");
    const info = lstatSync(absolute);
    if (info.isDirectory()) entries.push(...collectFiles(root, absolute));
    else if (info.isSymbolicLink()) entries.push({ path: relativePath, symlink: readlinkSync(absolute) });
    else if (info.isFile()) entries.push({ path: relativePath, size: info.size, sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex") });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function createArchive(packageRoot, archivePath, archiveType) {
  if (archiveType === "tar.gz") {
    execFileSync("tar", ["-czf", archivePath, "-C", dirname(packageRoot), relative(dirname(packageRoot), packageRoot)], { stdio: "inherit", env: childEnvironment() });
    return;
  }
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Compress-Archive -LiteralPath $env:AITEAM_AGENT_PACKAGE -DestinationPath $env:AITEAM_AGENT_ARCHIVE -Force"], { env: childEnvironment({ AITEAM_AGENT_PACKAGE: packageRoot, AITEAM_AGENT_ARCHIVE: archivePath }), stdio: "inherit" });
}

function run(command, args, cwd) {
  // Hosted macOS runners may expose Corepack without installing a `pnpm`
  // shim on the child PATH. Invoke the pinned package manager through
  // Corepack so packaging is independent of runner-specific shims.
  const usesPnpm = command === "pnpm";
  const executable = usesPnpm
    ? process.platform === "win32" ? "corepack.cmd" : "corepack"
    : command;
  const commandArgs = usesPnpm ? ["pnpm", ...args] : args;
  execFileSync(executable, commandArgs, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: childEnvironment({ CI: process.env.CI ?? "1" }),
  });
}
