import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Parse the small, dotenv-compatible config surface used by the packaged
 * Agent. Shell expansion is deliberately not supported: a package config is
 * data, not a script, and paths/URLs must be explicit.
 */
export function parseAgentEnvFile(text: string, source = "Agent config"): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [index, original] of text.split(/\r?\n/u).entries()) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = assignment.indexOf("=");
    if (separator <= 0) throw new Error(`${source}:${index + 1} must contain KEY=VALUE`);
    const key = assignment.slice(0, separator).trim();
    if (!ENV_NAME.test(key)) throw new Error(`${source}:${index + 1} contains an invalid variable name`);
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`${source}:${index + 1} defines ${key} more than once`);
    values[key] = parseValue(assignment.slice(separator + 1).trim(), source, index + 1);
  }
  return values;
}

/** Load the file named by AITEAM_CONFIG_FILE without overriding process env. */
export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): void {
  const filename = env.AITEAM_CONFIG_FILE?.trim();
  if (!filename) return;
  const configPath = resolve(filename);
  const values = parseAgentEnvFile(readFileSync(configPath, "utf8"), configPath);
  if (values.AITEAM_AGENT_JWKS_PATH && !isAbsolute(values.AITEAM_AGENT_JWKS_PATH)) values.AITEAM_AGENT_JWKS_PATH = resolve(dirname(configPath), values.AITEAM_AGENT_JWKS_PATH);
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) env[key] = value;
  }
}

function parseValue(value: string, source: string, line: number): string {
  if (!value) return "";
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return value;
  if (value.length < 2 || value.at(-1) !== quote) throw new Error(`${source}:${line} has an unterminated quoted value`);
  const inner = value.slice(1, -1);
  return quote === "'" ? inner : inner.replaceAll(/\\([\\"nrt])/gu, (_match, escaped: string) => ({ "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" }[escaped] ?? escaped));
}
