/**
 * 「技能管理」（侧栏 /skill-market）：企业技能 + 平台技能市场两个标签。
 * 企业技能是本企业的技能目录（导入技能、让模型帮我找、手动编辑都在「新增技能」里）；
 * 平台技能市场是运营端开放的技能，安装后进入企业技能。
 */
import { useState, type ReactNode } from "react";
import { Heading } from "@astryxdesign/core/Heading";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { VStack } from "@astryxdesign/core/VStack";
import { CapabilityPage } from "../capability";
import { SkillMarketPage } from "./SkillMarketPage";
import { capabilityUpdateLabel, useCapabilityUpdateCounts } from "../capability-updates";

type SkillTab = "enterprise" | "platform";

export function SkillManagementPage(): ReactNode {
  const [tab, setTab] = useState<SkillTab>("enterprise");
  const { skills: skillUpdates } = useCapabilityUpdateCounts();
  return (
    <VStack as="section" gap={5}>
      <Heading level={1}>技能管理</Heading>
      <TabList aria-label="技能来源" value={tab} onChange={(value) => setTab(value as SkillTab)} hasDivider>
        <Tab value="enterprise" label="企业技能"
          endContent={skillUpdates > 0 ? <StatusDot variant="error" label={capabilityUpdateLabel(skillUpdates)} tooltip={capabilityUpdateLabel(skillUpdates)} /> : undefined} />
        <Tab value="platform" label="平台技能市场" />
      </TabList>
      {tab === "enterprise" ? <CapabilityPage skillsOnly /> : <SkillMarketPage embedded />}
    </VStack>
  );
}
