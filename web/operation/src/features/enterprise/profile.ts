/** 企业资料（行业 / 标签）的解析与校验：开通表单与「编辑企业信息」共用，限制与服务端一致。 */
export const MAX_INDUSTRY_LENGTH = 20;
export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 20;

export function parseTags(text: string): string[] {
  return [...new Set(text.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))];
}

/** 返回第一条不满足的限制；全部满足时返回 null。 */
export function validateProfile(industry: string, tags: string[]): string | null {
  if (industry.trim().length > MAX_INDUSTRY_LENGTH) return `所属行业不超过 ${MAX_INDUSTRY_LENGTH} 字`;
  if (tags.length > MAX_TAGS) return `企业标签最多 ${MAX_TAGS} 个`;
  const tooLong = tags.find((tag) => tag.length > MAX_TAG_LENGTH);
  if (tooLong) return `标签「${tooLong}」超过 ${MAX_TAG_LENGTH} 字`;
  return null;
}
