/**
 * 专家：每位专家一行摘要（名称、分类、岗位描述、群主），点「展开」看系统提示词与依据。
 * 每位专家单独就地编辑；移除专家也在编辑里完成，保存后生效（规则还引用着时不允许）。
 */
import { useState, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { Box } from "./Box";
import { EvidenceList } from "./EvidenceList";
import { useSectionEdit, type SectionProps } from "./sectionEdit";
import type { EvidenceSource, GeneratedExpert } from "./types";
import { removalBlocker } from "./workflow";
import styles from "./workbench.module.css";

type Props = SectionProps & { evidenceSources: Record<string, EvidenceSource> };
interface Draft { display_name: string; category: string; description: string; system_prompt: string; remove: boolean }

function solutionMode(props: SectionProps): "solo" | "group" {
  return props.solution.mode ?? (props.solution.experts.length === 1 ? "solo" : "group");
}

export function ExpertsSection(props: Props): ReactNode {
  const { solution, active } = props;
  const othersEditing = active !== null && !active.startsWith("expert:");
  return (
    <Box
      id="section-experts"
      title={`专家（${solution.experts.length}）`}
      hint="点「展开」查看系统提示词与依据；每位专家单独编辑。"
      extra={props.canEdit && othersEditing ? <Text type="supporting" color="secondary">其他分区正在编辑</Text> : undefined}
    >
      <ul className={styles.rows} aria-label="专家">
        {solution.experts.map((expert) => <ExpertRow key={expert.key} expert={expert} {...props} />)}
      </ul>
    </Box>
  );
}

function ExpertRow({ expert, evidenceSources, ...props }: Props & { expert: GeneratedExpert }): ReactNode {
  const { solution, busy } = props;
  const [open, setOpen] = useState(false);
  const name = expert.display_name || expert.key;
  const group = solutionMode(props) === "group";
  const edit = useSectionEdit<Draft>(props, {
    key: `expert:${expert.key}`,
    label: `编辑专家 ${name}`,
    showLockedNote: false,
    pick: (s) => {
      const current = s.experts.find((item) => item.key === expert.key) ?? expert;
      return { display_name: current.display_name, category: current.category, description: current.description, system_prompt: current.system_prompt, remove: false };
    },
    apply: (s, d) => {
      if (d.remove) {
        const experts = s.experts.filter((item) => item.key !== expert.key);
        return { ...s, experts, coordinator_key: s.coordinator_key === expert.key ? experts[0]!.key : s.coordinator_key };
      }
      const { remove: _remove, ...changes } = d;
      return { ...s, experts: s.experts.map((item) => (item.key === expert.key ? { ...item, ...changes } : item)) };
    },
    validate: (next, d) => {
      if (d.remove) return removalBlocker(next.orchestration_rules, expert.key);
      return !d.display_name.trim() || !d.category.trim() || !d.description.trim() || !d.system_prompt.trim()
        ? "专家的名称、分类、岗位描述和系统提示词都不能为空" : null;
    },
  });
  const draft = edit.draft;
  const expanded = open || edit.editing;
  const removable = solution.experts.length > 1;

  return (
    <li className={styles.item} data-testid="expert-row">
      <div className={styles.rowHead}>
        <div className={styles.rowMain}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text weight="semibold">{name}</Text>
            <Badge label={expert.category} />
            {group && expert.key === solution.coordinator_key && <Badge label="群主" variant="info" />}
          </HStack>
          <Text type="supporting" color="secondary">{expert.description}</Text>
        </div>
        <div className={styles.rowSide}>
          {!edit.editing && (
            <Button
              label={`${open ? "收起" : "展开"}专家 ${name}`}
              variant="ghost" size="sm" aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? "收起" : "展开"}
            </Button>
          )}
          {edit.editButton}
        </div>
      </div>
      {expanded && (
        <div className={styles.inset}>
          {draft ? (
            draft.remove ? (
              <Banner status="warning" title={`保存后将从方案中移除「${name}」`} description={group && expert.key === solution.coordinator_key ? "TA 是群主：移除后群主改为第一位专家，需要重新确认。" : undefined} />
            ) : (
              <FormLayout>
                <TextInput label="专家名称" value={draft.display_name} onChange={(display_name) => edit.update((d) => ({ ...d, display_name }))} isRequired isDisabled={busy} />
                <TextInput label="分类" value={draft.category} onChange={(category) => edit.update((d) => ({ ...d, category }))} isRequired isDisabled={busy} />
                <TextArea label="岗位描述" value={draft.description} onChange={(description) => edit.update((d) => ({ ...d, description }))} rows={2} maxLength={200} isRequired isDisabled={busy} />
                <TextArea label="系统提示词" value={draft.system_prompt} onChange={(system_prompt) => edit.update((d) => ({ ...d, system_prompt }))} rows={6} maxLength={8000} isRequired isDisabled={busy} />
              </FormLayout>
            )
          ) : (
            <VStack gap={2}>
              <VStack gap={1}><Text type="supporting" weight="semibold">系统提示词</Text><Text textWrap="pretty">{expert.system_prompt}</Text></VStack>
              <VStack gap={1}><Text type="supporting" weight="semibold">依据</Text><EvidenceList items={expert.evidence} sources={evidenceSources} /></VStack>
            </VStack>
          )}
          {draft && removable && (
            <HStack hAlign="end">
              <Button
                label={draft.remove ? `撤销移除 ${name}` : `移除专家 ${name}`}
                variant="ghost" size="sm" isDisabled={busy}
                onClick={() => edit.update((d) => ({ ...d, remove: !d.remove }))}
              >
                {draft.remove ? "撤销移除" : "移除这位专家"}
              </Button>
            </HStack>
          )}
          {edit.footer}
        </div>
      )}
    </li>
  );
}
