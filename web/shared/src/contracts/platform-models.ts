/**
 * 平台模型的「可选」规则（D18）：Operator 已发布、且价格已生效（pricing_status=known）。
 *
 * 运营端（开通企业、开放模型、行业方案生成）与企业端（招募、应用方案、专家配置）都按这条规则
 * 过滤模型下拉；跨端 e2e 也直接用它挑选模型。规则集中在这里，避免各处各写一份后走样。
 * 服务端以同样规则在写入前校验。字段宽松（可缺省），接口原始 JSON 也能直接传入。
 */
export interface PlatformModelAvailability {
  model?: { status?: unknown } | null;
  rate?: { pricing_status?: unknown } | null;
}

export function isSelectablePlatformModel(item: PlatformModelAvailability): boolean {
  return item.model?.status === "published" && item.rate?.pricing_status === "known";
}
