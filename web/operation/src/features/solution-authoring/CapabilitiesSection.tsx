/**
 * 能力清单：各专家推荐的 skill / MCP 合并去重后展示（发布时就是这份方案级推荐清单）。
 * 只是提示，不影响提交。就地编辑可去掉不需要的推荐，也可从平台技能目录或 ClawHub 添加 skill
 * （ClawHub 的先导入平台目录；只能选平台已发布的固定版本），添加时指定推荐给哪位专家。
 */
import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { PlatformSkillSelector } from "../skill-market/PlatformSkillSelector";
import type { PlatformSkillRef } from "../skill-market/types";
import { useSkillMarketApi } from "../skill-market/useSkillMarketApi";
import { Box, Row, Rows } from "./Box";
import { useSectionEdit, type SectionProps } from "./sectionEdit";
import type { GeneratedSolution } from "./types";
import styles from "./workbench.module.css";

export interface CapabilityItem { id: string; kind: "skill" | "mcp"; ref: string; name: string; purpose: string; experts: string[]; version?: string }

/** 与发布时 `_recommended_capabilities` 同口径：按 (类型, 标识) 去重、保序，说明取第一次出现的。 */
export function capabilityItems(solution: GeneratedSolution): CapabilityItem[] {
  const items = new Map<string, CapabilityItem>();
  for (const expert of solution.experts) {
    const who = expert.display_name || expert.key;
    const add = (kind: "skill" | "mcp", ref: string, name: string, purpose: string, version?: string) => {
      const id = `${kind}:${ref}`;
      const item = items.get(id) ?? { id, kind, ref, name, purpose, experts: [], ...(version ? { version } : {}) };
      if (!item.experts.includes(who)) item.experts.push(who);
      items.set(id, item);
    };
    for (const skill of expert.skills ?? []) add("skill", skill.skill_id, skill.skill_id, skill.reason, skill.version);
    for (const mcp of expert.mcps ?? []) add("mcp", mcp.key, mcp.display_name, mcp.purpose);
  }
  return [...items.values()];
}

export interface CapabilityDraft {
  /** 要去掉的推荐（`kind:ref`），从所有专家上去掉。 */
  removed: string[];
  /** 新增的 skill（平台已发布固定版本）。 */
  added: PlatformSkillRef[];
  /** 新增 skill 推荐给哪位专家。 */
  target: string;
}

/** 先去掉移除项，再把新增 skill 挂到目标专家上（同一专家已有同一 skill 时换成新版本）。 */
export function applyCapabilities(solution: GeneratedSolution, draft: CapabilityDraft): GeneratedSolution {
  const gone = new Set(draft.removed);
  return {
    ...solution,
    experts: solution.experts.map((expert) => {
      const skills = (expert.skills ?? []).filter((skill) => !gone.has(`skill:${skill.skill_id}`));
      const mcps = (expert.mcps ?? []).filter((mcp) => !gone.has(`mcp:${mcp.key}`));
      if (expert.key !== draft.target || draft.added.length === 0) return { ...expert, skills, mcps };
      const added = new Set(draft.added.map((ref) => ref.skill_id));
      return {
        ...expert,
        mcps,
        skills: [
          ...skills.filter((skill) => !added.has(skill.skill_id)),
          ...draft.added.map((ref) => ({ ...ref, reason: "" })),
        ],
      };
    }),
  };
}

/**
 * 平台 skill_id 是 UUID，直接展示没法读：从内部技能市场取名称（含已下架的，便于认出要移除的项）。
 * 要展示的 id 变化时重新读取（ClawHub 刚导入的也能显示名称）；读不到时退回展示 id。
 */
function useSkillNames(ids: string[]): Map<string, string> {
  const api = useSkillMarketApi();
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const key = [...new Set(ids)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    let active = true;
    api.listInternal()
      .then((list) => { if (active) setNames(new Map(list.map((skill) => [skill.skill_id, skill.display_name || `${skill.owner}/${skill.slug}`]))); })
      .catch(() => {});
    return () => { active = false; };
  }, [api, key]);
  return names;
}

const skillLabel = (names: Map<string, string>, skillId: string, version?: string) =>
  `${names.get(skillId) ?? skillId}${version ? ` v${version}` : ""}`;

export function CapabilitiesSection(props: SectionProps): ReactNode {
  const { solution, busy } = props;
  const items = capabilityItems(solution);
  const group = (solution.mode ?? (solution.experts.length === 1 ? "solo" : "group")) === "group";
  const edit = useSectionEdit<CapabilityDraft>(props, {
    key: "capabilities",
    label: "编辑能力清单",
    pick: (s) => ({ removed: [], added: [], target: s.experts.some((e) => e.key === s.coordinator_key) ? s.coordinator_key : s.experts[0]?.key ?? "" }),
    apply: applyCapabilities,
    // 每位专家最多 10 个 skill（与后端 schema 一致）。
    validate: (next) => {
      const over = next.experts.find((expert) => (expert.skills ?? []).length > 10);
      return over ? `专家「${over.display_name || over.key}」最多推荐 10 个 skill` : null;
    },
  });
  const draft = edit.draft;
  const removed = draft?.removed ?? [];
  const names = useSkillNames([
    ...items.filter((item) => item.kind === "skill").map((item) => item.ref),
    ...(draft?.added ?? []).map((ref) => ref.skill_id),
  ]);
  return (
    <Box
      id="section-capabilities"
      title="能力清单"
      hint="推荐的 skill 与 MCP 只是提示，不影响提交；用户使用方案时，需要才会询问是否安装。"
      extra={edit.editButton}
    >
      {items.length === 0 && !draft ? (
        <Text type="supporting" color="secondary">没有推荐能力。</Text>
      ) : items.length > 0 && (
        <Rows label="推荐能力">
          {items.map((item) => {
            const gone = removed.includes(item.id);
            return (
              <Row
                key={item.id}
                main={<>
                  <Text weight="semibold" style={gone ? { textDecoration: "line-through" } : undefined}>
                    {item.kind === "mcp"
                      ? `MCP · ${item.name !== item.ref ? `${item.name}（${item.ref}）` : item.ref}`
                      : `skill · ${skillLabel(names, item.ref, item.version)}`}
                  </Text>
                  <Text type="supporting" color="secondary">{[item.purpose, `来自：${item.experts.join("、")}`].filter(Boolean).join(" · ")}</Text>
                </>}
                side={draft ? (
                  <Button
                    label={`${gone ? "撤销移除" : "移除"} ${item.kind === "skill" ? names.get(item.ref) ?? item.ref : item.name}`}
                    variant="ghost" size="sm" isDisabled={busy}
                    onClick={() => edit.update((d) => ({ ...d, removed: gone ? d.removed.filter((id) => id !== item.id) : [...d.removed, item.id] }))}
                  >
                    {gone ? "撤销移除" : "移除"}
                  </Button>
                ) : <Badge label={item.kind === "mcp" ? "用户本机安装" : "平台目录"} variant="neutral" />}
              />
            );
          })}
        </Rows>
      )}
      {draft && (
        <div className={styles.inset} data-testid="capability-add">
          <VStack gap={3}>
            <Text weight="semibold">添加 skill</Text>
            {group && (
              <Selector
                label="推荐给"
                options={solution.experts.map((expert) => ({ value: expert.key, label: expert.display_name || expert.key }))}
                value={draft.target}
                onChange={(target) => edit.update((d) => ({ ...d, target }))}
                isDisabled={busy}
              />
            )}
            <PlatformSkillSelector
              title={null}
              purpose="添加到方案"
              value={draft.added}
              onChange={(added) => edit.update((d) => ({ ...d, added }))}
              disabled={busy}
            />
            {draft.added.length > 0 && (
              <Text type="supporting" color="secondary">保存后新增：{draft.added.map((ref) => skillLabel(names, ref.skill_id, ref.version)).join("、")}</Text>
            )}
          </VStack>
        </div>
      )}
      {edit.footer}
    </Box>
  );
}
