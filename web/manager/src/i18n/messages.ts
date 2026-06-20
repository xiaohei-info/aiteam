/** 企业端 i18n 文案（注册进共享 I18n 实例，与 sharedMessages 合并）。 */
import type { LocaleCatalog } from "@aiteam/shared";

export const managerMessages: LocaleCatalog = {
  "zh-CN": {
    "manager.title": "AI Team 企业端",
    "manager.nav.dashboard": "企业概览",
    "manager.nav.members": "成员账号",
    "manager.nav.experts": "招募专家",
    "manager.nav.grants": "成员级授权",
    "manager.nav.governance": "企业治理",
    "manager.login.account": "成员账号",
    "manager.login.password": "登录密码",
    "manager.login.submit": "登录",
    "manager.login.required": "请填写账号与密码",
    "manager.login.pending_backend": "登录联调待后续卡接入（本端 /api/auth/login）",
    "manager.placeholder": "（脚手架占位，业务页由后续卡接入）",
  },
};
