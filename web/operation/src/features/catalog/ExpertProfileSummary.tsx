import type { ReactNode } from "react";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import { OUTPUT_TYPE_LABELS, formatPricingSummary, profileFromItem } from "./profile";
import type { CatalogItem } from "./types";

/** 只读展示人才市场字段；未填写的行隐藏，全部未填写时给一句提示。 */
export function ExpertProfileSummary({ item }: { item: CatalogItem }): ReactNode {
  const profile = profileFromItem(item);
  const permissions = profile.required_permissions;
  const permissionText = permissions
    ? [permissions.full_access && "完全访问", permissions.local_directories && "本机目录"].filter(Boolean).join("、") || "无需额外权限"
    : "";
  const rows: Array<[string, string]> = [
    ["一句话定位", profile.tagline],
    ["适用场景", profile.use_cases.join("；")],
    ["不适用场景", profile.limitations.join("；")],
    ["示例问题", profile.example_prompts.join("；")],
    ["产出类型", profile.output_types.map((type) => OUTPUT_TYPE_LABELS[type]).join("、")],
    ["示例产出", profile.sample_outputs.map((output) => `${output.title}（${OUTPUT_TYPE_LABELS[output.output_type]}）`).join("；")],
    ["必需的外部系统", profile.required_connectors.join("、")],
    ["可选的外部系统", profile.optional_connectors.join("、")],
    ["推荐知识", profile.recommended_knowledge.join("、")],
    ["需要的权限", permissionText],
    ["计价", profile.pricing ? formatPricingSummary(profile.pricing) : ""],
    ["记忆策略", profile.memory_policy_summary],
    ["发布者", profile.publisher],
    ["更新说明", profile.changelog_url],
    ["更新时间", item.updated_at ?? ""],
  ];
  const filled = rows.filter(([, value]) => value);
  if (!filled.length) return <Text color="secondary">尚未填写人才市场展示字段</Text>;
  return (
    <MetadataList columns="single">
      {filled.map(([label, value]) => (
        <MetadataListItem key={label} label={label}><Text>{value}</Text></MetadataListItem>
      ))}
    </MetadataList>
  );
}
