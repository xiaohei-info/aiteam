/**
 * 能力清单：各专家推荐的 skill / MCP 合并去重后展示（发布时就是这份方案级推荐清单）。
 * 只是提示，不影响提交。就地编辑可去掉不需要的推荐；新增 skill 只能来自平台目录，请重新生成。
 */
import type { ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { Box, Row, Rows } from "./Box";
import { useSectionEdit, type SectionProps } from "./sectionEdit";
import type { GeneratedSolution } from "./types";

export interface CapabilityItem { id: string; kind: "skill" | "mcp"; ref: string; name: string; purpose: string; experts: string[] }

/** 与发布时 `_recommended_capabilities` 同口径：按 (类型, 标识) 去重、保序，说明取第一次出现的。 */
export function capabilityItems(solution: GeneratedSolution): CapabilityItem[] {
  const items = new Map<string, CapabilityItem>();
  for (const expert of solution.experts) {
    const who = expert.display_name || expert.key;
    const add = (kind: "skill" | "mcp", ref: string, name: string, purpose: string) => {
      const id = `${kind}:${ref}`;
      const item = items.get(id) ?? { id, kind, ref, name, purpose, experts: [] };
      if (!item.experts.includes(who)) item.experts.push(who);
      items.set(id, item);
    };
    for (const skill of expert.skills ?? []) add("skill", skill.skill_id, skill.skill_id, skill.reason);
    for (const mcp of expert.mcps ?? []) add("mcp", mcp.key, mcp.display_name, mcp.purpose);
  }
  return [...items.values()];
}

function withoutCapabilities(solution: GeneratedSolution, removed: readonly string[]): GeneratedSolution {
  const gone = new Set(removed);
  return {
    ...solution,
    experts: solution.experts.map((expert) => ({
      ...expert,
      skills: (expert.skills ?? []).filter((skill) => !gone.has(`skill:${skill.skill_id}`)),
      mcps: (expert.mcps ?? []).filter((mcp) => !gone.has(`mcp:${mcp.key}`)),
    })),
  };
}

export function CapabilitiesSection(props: SectionProps): ReactNode {
  const items = capabilityItems(props.solution);
  const edit = useSectionEdit<string[]>({ ...props, canEdit: props.canEdit && items.length > 0 }, {
    key: "capabilities",
    label: "编辑能力清单",
    pick: () => [],
    apply: withoutCapabilities,
  });
  const removed = edit.draft ?? [];
  return (
    <Box
      id="section-capabilities"
      title="能力清单"
      hint="推荐的 skill 与 MCP 只是提示，不影响提交；用户使用方案时，需要才会询问是否安装。新增 skill 只能来自平台目录，请重新生成。"
      extra={edit.editButton}
    >
      {items.length === 0 ? (
        <Text type="supporting" color="secondary">没有推荐能力。</Text>
      ) : (
        <Rows label="推荐能力">
          {items.map((item) => {
            const gone = removed.includes(item.id);
            return (
              <Row
                key={item.id}
                main={<>
                  <Text weight="semibold" style={gone ? { textDecoration: "line-through" } : undefined}>
                    {item.kind === "mcp" ? "MCP" : "skill"} · {item.name !== item.ref ? `${item.name}（${item.ref}）` : item.ref}
                  </Text>
                  <Text type="supporting" color="secondary">{[item.purpose, `来自：${item.experts.join("、")}`].filter(Boolean).join(" · ")}</Text>
                </>}
                side={edit.editing ? (
                  <Button
                    label={`${gone ? "撤销移除" : "移除"} ${item.name}`}
                    variant="ghost" size="sm" isDisabled={props.busy}
                    onClick={() => edit.update((ids) => (gone ? ids.filter((id) => id !== item.id) : [...ids, item.id]))}
                  >
                    {gone ? "撤销移除" : "移除"}
                  </Button>
                ) : gone ? undefined : <Badge label={item.kind === "mcp" ? "用户本机安装" : "平台目录"} variant="neutral" />}
              />
            );
          })}
        </Rows>
      )}
      {edit.footer}
    </Box>
  );
}
