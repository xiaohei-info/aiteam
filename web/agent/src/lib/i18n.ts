/**
 * 用户端 i18n 装配（08 §12.2）。复用 shared 基础 messages，extend agent 命名空间。
 */

import { createI18n, sharedMessages, type I18n } from "@aiteam/shared/i18n";

export type I18nInstance = I18n;

const agentMessages = {
  "zh-CN": {
    "agent.title": "AI Team 用户端",
    "agent.nav.workspace": "工作台",
    "agent.nav.private_chat": "私聊",
    "agent.nav.group_chat": "群聊",
    "agent.login.title": "登录",
    "agent.login.account": "账号（手机号 / 用户名）",
    "agent.login.password": "密码",
    "agent.login.tenant_hint": "企业提示（可选）",
    "agent.login.submit": "登录",
    "agent.login.loading": "登录中…",
    "agent.login.failed": "登录失败：{detail}",
    "agent.workspace.loading": "加载中…",
    "agent.workspace.load_error": "加载失败",
    "agent.workspace.action_error": "操作失败，请重试",
    "agent.workspace.summary": "会话",
    "agent.workspace.enabled": "启用中",
    "agent.workspace.conversations_title": "近期会话",
    "agent.workspace.conversations_empty": "暂无会话",
    "agent.workspace.loops_title": "Loop 调度",
    "agent.workspace.loops_empty": "暂无 Loop",
    "agent.workspace.enable": "启用",
    "agent.workspace.disable": "停用",
    "agent.workspace.fire": "立即触发",
  },
};

export function createAgentI18n(): I18n {
  const catalog = { ...sharedMessages };
  for (const [locale, msgs] of Object.entries(agentMessages)) {
    catalog[locale] = { ...(catalog[locale] ?? {}), ...msgs };
  }
  return createI18n({ catalog });
}
