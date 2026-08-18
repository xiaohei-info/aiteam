import {
  createExtensionRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { skillResourcePaths, SkillCache } from "../skills.js";
import type { SessionAuthorization } from "./session-host.js";

export function createControlledResourceLoader(systemPrompt: string, cache?: SkillCache, authorization?: SessionAuthorization): ResourceLoader {
  const skillScope = authorization?.caller.tenantId && (authorization.caller.userId ?? authorization.caller.callerId)
    ? { tenantId: authorization.caller.tenantId, memberId: authorization.caller.userId ?? authorization.caller.callerId }
    : undefined;
  const skillRefs = authorization ? (Array.isArray(authorization.snapshot.skill_refs) ? authorization.snapshot.skill_refs.filter((ref): ref is string => typeof ref === "string") : []) : [];
  const verification = { publicKey: process.env.AITEAM_SKILL_SIGNING_PUBLIC_KEY, keyId: process.env.AITEAM_SKILL_SIGNING_KEY_ID };
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => skillScope && cache && verification.publicKey && verification.keyId ? skillResourcePaths(cache, skillScope, skillRefs, verification) : ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}
