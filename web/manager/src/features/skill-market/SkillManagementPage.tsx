/**
 * 「技能管理」（侧栏 /skill-market）：企业的技能只有一个列表，「来源」列标明平台市场 / 自定义 / 网址 / ClawHub。
 * 平台技能经「新增技能 → 添加平台技能」加入列表，不再单独展示「平台技能市场」（2026-11-21 用户要求：列表数据与交互预期一致）。
 */
import type { ReactNode } from "react";
import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/VStack";
import { CapabilityPage } from "../capability";

export function SkillManagementPage(): ReactNode {
  return (
    <VStack as="section" gap={5}>
      <Heading level={1}>技能管理</Heading>
      <CapabilityPage skillsOnly />
    </VStack>
  );
}
