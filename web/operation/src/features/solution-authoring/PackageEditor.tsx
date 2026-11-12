/**
 * 方案正文：查看与编辑。依据（来源片段）只读，编辑时原样保留。
 *
 * 编辑中的内容只存在这个组件里：服务端数据刷新（轮询、别的动作、版本冲突后重拉）不会清掉它，
 * 只有保存成功或使用者主动放弃才丢弃。
 */
import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import type { Evidence, EvidenceSource, GeneratedExpert, GeneratedSolution } from "./types";

export interface SaveFailure {
  message: string;
  /** 草稿在编辑期间被别人改过（版本不一致）。 */
  conflict: boolean;
}

interface Props {
  solution: GeneratedSolution;
  /** 服务端当前版本；开始编辑时记下，保存时带上。 */
  version: number;
  evidenceSources: Record<string, EvidenceSource>;
  canEdit: boolean;
  busy: boolean;
  /** `baseVersion` 是这次修改所基于的版本。成功返回 null。 */
  onSave: (next: GeneratedSolution, baseVersion: number) => Promise<SaveFailure | null>;
  /** 进入 / 退出编辑时通知页面，用来锁住会改动正文的其它操作。 */
  onEditingChange: (editing: boolean) => void;
}

function EvidenceList({ items, sources }: { items: Evidence[]; sources: Record<string, EvidenceSource> }): ReactNode {
  const known = items.filter((item) => sources[item.chunk_id]);
  if (known.length === 0) return <Text type="supporting" color="secondary">没有引用资料（人工新增或编辑的内容）。</Text>;
  return (
    <VStack gap={2}>
      {known.map((item) => {
        const source = sources[item.chunk_id]!;
        return (
          <VStack key={item.chunk_id} gap={1}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text type="supporting" weight="semibold">{source.source_name} · {source.locator}</Text>
              {source.origin === "image" && <Badge label="来自图片识别" variant="info" />}
              {source.low_confidence && <Badge label="识别置信度低，请核对原图" variant="warning" />}
            </HStack>
            <Text type="supporting" color="secondary">{item.quote || source.excerpt}</Text>
          </VStack>
        );
      })}
    </VStack>
  );
}

function validate(solution: GeneratedSolution): string | null {
  if (!solution.display_name.trim() || !solution.description.trim()) return "方案名称和方案描述不能为空";
  for (const expert of solution.experts) {
    if (!expert.display_name.trim() || !expert.category.trim() || !expert.description.trim() || !expert.system_prompt.trim()) {
      return `专家「${expert.display_name || expert.key}」的名称、分类、岗位描述和系统提示词都不能为空`;
    }
  }
  return null;
}

export function PackageEditor({ solution, version, evidenceSources, canEdit, busy, onSave, onEditingChange }: Props): ReactNode {
  const [draft, setDraft] = useState<GeneratedSolution | null>(null);
  const [baseVersion, setBaseVersion] = useState(version);
  const [tagsText, setTagsText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const editing = draft !== null;
  const current = draft ?? solution;

  useEffect(() => {
    onEditingChange(editing);
    return () => onEditingChange(false);
  }, [editing, onEditingChange]);

  function startEditing() {
    setDraft(structuredClone(solution));
    setBaseVersion(version);
    setTagsText(solution.tags.join("，"));
    setError(null);
    setConflict(false);
  }

  function stopEditing() {
    setDraft(null);
    setError(null);
    setConflict(false);
  }

  function setExpert(key: string, changes: Partial<GeneratedExpert>) {
    setDraft((value) => value && { ...value, experts: value.experts.map((expert) => expert.key === key ? { ...expert, ...changes } : expert) });
  }

  function removeExpert(key: string) {
    setDraft((value) => {
      if (!value) return value;
      const experts = value.experts.filter((expert) => expert.key !== key);
      return { ...value, experts, coordinator_key: value.coordinator_key === key ? experts[0]!.key : value.coordinator_key };
    });
  }

  async function save() {
    if (!draft) return;
    const tags = tagsText.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
    const next = { ...draft, tags };
    const problem = validate(next);
    if (problem) { setError(problem); return; }
    setError(null);
    // 冲突后再保存是使用者明确选择的「覆盖」：改用服务端最新版本。
    const failure = await onSave(next, conflict ? version : baseVersion);
    if (!failure) { stopEditing(); return; }
    setConflict(failure.conflict);
    if (!failure.conflict) setError(failure.message);
  }

  const coordinator = current.experts.find((expert) => expert.key === current.coordinator_key);

  return (
    <Card>
      <VStack gap={5}>
        <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
          <Heading level={2}>方案正文</Heading>
          {canEdit && !editing && <Button label="编辑正文" variant="secondary" onClick={startEditing} isDisabled={busy} />}
        </HStack>

        {editing ? (
          <FormLayout>
            <TextInput label="方案名称" value={current.display_name} onChange={(display_name) => setDraft({ ...current, display_name })} isRequired isDisabled={busy} />
            <TextArea label="方案描述" value={current.description} onChange={(description) => setDraft({ ...current, description })} rows={3} maxLength={1000} isRequired isDisabled={busy} />
            <TextInput label="标签" value={tagsText} onChange={setTagsText} description="用逗号分隔，最多 8 个" isOptional isDisabled={busy} />
            <Selector
              label="协调专家"
              options={current.experts.map((expert) => ({ value: expert.key, label: expert.display_name || expert.key }))}
              value={current.coordinator_key}
              onChange={(coordinator_key) => setDraft({ ...current, coordinator_key })}
              isRequired
              isDisabled={busy}
            />
            <TextArea label="协作说明" value={current.coordinator_instructions} onChange={(coordinator_instructions) => setDraft({ ...current, coordinator_instructions })} rows={4} maxLength={4000} isOptional isDisabled={busy} />
            <TextArea label="交付要求" value={current.output_requirements} onChange={(output_requirements) => setDraft({ ...current, output_requirements })} rows={4} maxLength={4000} isOptional isDisabled={busy} />
          </FormLayout>
        ) : (
          <VStack gap={3}>
            <VStack gap={1}>
              <Heading level={3}>{current.display_name}</Heading>
              <Text>{current.description}</Text>
            </VStack>
            {current.tags.length > 0 && <HStack gap={2} wrap="wrap">{current.tags.map((tag) => <Badge key={tag} label={tag} />)}</HStack>}
            <VStack gap={1}><Text weight="semibold">协调专家</Text><Text>{coordinator?.display_name ?? current.coordinator_key}</Text></VStack>
            <VStack gap={1}><Text weight="semibold">协作说明</Text><Text>{current.coordinator_instructions || "（未填写）"}</Text></VStack>
            <VStack gap={1}><Text weight="semibold">交付要求</Text><Text>{current.output_requirements || "（未填写）"}</Text></VStack>
            <VStack gap={1}><Text weight="semibold">方案依据</Text><EvidenceList items={current.evidence} sources={evidenceSources} /></VStack>
          </VStack>
        )}

        <VStack gap={4}>
          <Heading level={3}>专家团队（{current.experts.length}）</Heading>
          {current.experts.map((expert) => (
            <Card key={expert.key} variant="muted">
              {editing ? (
                <VStack gap={3}>
                  <FormLayout>
                    <TextInput label="专家名称" value={expert.display_name} onChange={(display_name) => setExpert(expert.key, { display_name })} isRequired isDisabled={busy} />
                    <TextInput label="分类" value={expert.category} onChange={(category) => setExpert(expert.key, { category })} isRequired isDisabled={busy} />
                    <TextArea label="岗位描述" value={expert.description} onChange={(description) => setExpert(expert.key, { description })} rows={2} maxLength={200} isRequired isDisabled={busy} />
                    <TextArea label="系统提示词" value={expert.system_prompt} onChange={(system_prompt) => setExpert(expert.key, { system_prompt })} rows={6} maxLength={8000} isRequired isDisabled={busy} />
                  </FormLayout>
                  {current.experts.length > 1 && (
                    <HStack hAlign="end">
                      <Button label={`移除专家 ${expert.display_name || expert.key}`} variant="ghost" size="sm" onClick={() => removeExpert(expert.key)} isDisabled={busy}>移除这位专家</Button>
                    </HStack>
                  )}
                </VStack>
              ) : (
                <VStack gap={2}>
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <Text weight="semibold">{expert.display_name}</Text>
                    <Badge label={expert.category} />
                    {expert.key === current.coordinator_key && <Badge label="协调专家" variant="info" />}
                  </HStack>
                  <Text>{expert.description}</Text>
                  <VStack gap={1}><Text type="supporting" weight="semibold">系统提示词</Text><Text textWrap="pretty">{expert.system_prompt}</Text></VStack>
                  <VStack gap={1}><Text type="supporting" weight="semibold">依据</Text><EvidenceList items={expert.evidence} sources={evidenceSources} /></VStack>
                </VStack>
              )}
            </Card>
          ))}
        </VStack>

        {error && <Banner status="error" title={error} />}
        {editing && conflict && (
          <Banner
            status="warning"
            title="保存失败：草稿在你编辑期间被其他人改动过"
            description="你的修改还在上面，没有丢失。可以用你的内容覆盖保存，也可以放弃修改查看最新内容。"
          />
        )}
        {editing && (
          <HStack gap={2}>
            <Button label={conflict ? "覆盖保存" : "保存"} onClick={() => void save()} isLoading={busy} />
            <Button label={conflict ? "放弃我的修改" : "取消"} variant="ghost" onClick={stopEditing} isDisabled={busy} />
          </HStack>
        )}
      </VStack>
    </Card>
  );
}
