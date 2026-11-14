/**
 * 平台模型的「可选」规则（D18）：Operator 已发布、且价格已生效（pricing_status=known）。
 *
 * 运营端（开通企业、开放模型、行业方案生成）与企业端（招募、应用方案、专家配置）都按这条规则
 * 过滤模型下拉；规则集中在这里，避免各处各写一份后走样。服务端以同样规则在写入前校验。
 */
export interface PlatformModelAvailability {
  model: { status: string };
  rate?: { pricing_status?: string | null } | null;
}

export function isSelectablePlatformModel(item: PlatformModelAvailability): boolean {
  return item.model.status === "published" && item.rate?.pricing_status === "known";
}
