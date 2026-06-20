/** 运营端 i18n 文案（注册进共享 I18n 实例，与 sharedMessages 合并）。 */
import type { LocaleCatalog } from "@aiteam/shared";

export const operationMessages: LocaleCatalog = {
  "zh-CN": {
    "operation.title": "AI Team 运营端",
    "operation.nav.dashboard": "概览",
    "operation.nav.enterprises": "企业开通",
    "operation.nav.catalog": "目录治理",
    "operation.nav.board": "跨企业看板",
    "operation.login.phone": "负责人手机号",
    "operation.login.secret": "一次性 bootstrap 凭据",
    "operation.login.submit": "登录",
    "operation.login.required": "请填写手机号与凭据",
    "operation.login.pending_backend": "登录联调待后续卡接入（本端 /api/auth/login）",
    "operation.placeholder": "（脚手架占位，业务页由后续卡接入）",
  },
};
