#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Remove inherited control-plane credentials before loading the package config or runtime.
const { scrubAgentEnvironment } = await import("../dist/launch-guards.js");
scrubAgentEnvironment();
const options = parseArgs(process.argv.slice(2));
const configFile = options.config ?? process.env.AITEAM_CONFIG_FILE ?? join(packageRoot, "config", "agent.env");

if (existsSync(configFile)) process.env.AITEAM_CONFIG_FILE = resolve(configFile);
else if (options.config) throw new Error(`Agent config file does not exist: ${configFile}`);
if (process.env.AITEAM_CONFIG_FILE && existsSync(process.env.AITEAM_CONFIG_FILE)) {
  const { loadAgentConfig } = await import("../dist/config.js");
  loadAgentConfig();
  scrubAgentEnvironment();
}

process.env.HOST ??= "127.0.0.1";
process.env.PORT ??= "8180";
process.env.AITEAM_AGENT_LOCAL_ONLY ??= "true";
process.env.AITEAM_AGENT_SPA_ROOT ??= join(packageRoot, "web", "agent", "dist");
process.env.AITEAM_AGENT_DATA_DIR ??= defaultDataDir();
process.env.AITEAM_AGENT_PORT_FILE ??= join(process.env.AITEAM_AGENT_DATA_DIR, "agent-port.json");

await import("../dist/main.js");

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const equals = argument.indexOf("=");
    const name = equals < 0 ? argument : argument.slice(0, equals);
    const inlineValue = equals < 0 ? undefined : argument.slice(equals + 1);
    const value = inlineValue ?? args[++index];
    switch (name) {
      case "--config":
        options.config = requiredValue(name, value);
        break;
      case "--host":
        process.env.HOST = requiredValue(name, value);
        break;
      case "--port":
        process.env.PORT = requiredValue(name, value);
        break;
      case "--data-dir":
        process.env.AITEAM_AGENT_DATA_DIR = requiredValue(name, value);
        break;
      case "--manager-url":
        process.env.AITEAM_MANAGER_URL = requiredValue(name, value);
        break;
      case "--allowed-origins":
        process.env.AITEAM_AGENT_ALLOWED_ORIGINS = requiredValue(name, value);
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown Agent launcher option: ${argument}`);
    }
  }
  return options;
}

function requiredValue(name, value) {
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function defaultDataDir() {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "AI Team", "agent");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "AI Team", "agent");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "aiteam", "agent");
}

function printHelp() {
  console.log(`AI Team Agent sidecar\n\nUsage: start-agent [options]\n\nOptions:\n  --config <file>           External env config (default: config/agent.env)\n  --manager-url <url>       Override AITEAM_MANAGER_URL\n  --host <host>             Bind host (default: 127.0.0.1)\n  --port <port>             Bind port, 0 chooses a free port\n  --data-dir <directory>    User data directory\n  --allowed-origins <list>  Exact comma-separated client origins\n`);
}
