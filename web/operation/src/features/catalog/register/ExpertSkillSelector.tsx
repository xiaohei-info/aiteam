import { useEffect, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useSkillMarketApi } from "../../skill-market/useSkillMarketApi";
import type { ExternalSkill, InternalSkill, PlatformSkillRef } from "../../skill-market/types";

interface ExpertSkillSelectorProps {
  value: PlatformSkillRef[];
  onChange: (value: PlatformSkillRef[]) => void;
  disabled: boolean;
}

function refFor(skill: InternalSkill): PlatformSkillRef | null {
  if (!skill.published_version || !skill.content_hash || skill.status !== "published") return null;
  return { skill_id: skill.skill_id, version: skill.published_version, content_hash: skill.content_hash };
}

export function ExpertSkillSelector({ value, onChange, disabled }: ExpertSkillSelectorProps) {
  const api = useSkillMarketApi();
  const [tab, setTab] = useState<"internal" | "external">("internal");
  const [internal, setInternal] = useState<InternalSkill[]>([]);
  const [external, setExternal] = useState<ExternalSkill[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([api.listInternal(), api.listExternal(query.trim() || undefined)])
      .then(([inside, outside]) => {
        if (!active) return;
        setInternal(inside);
        setExternal(outside);
      })
      .catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "技能市场加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, query]);

  const available = internal.filter((skill) => refFor(skill));
  const selectedIds = value.map((ref) => ref.skill_id);

  function selectInternal(ids: string[]) {
    onChange(ids.flatMap((id) => {
      const skill = available.find((item) => item.skill_id === id);
      const ref = skill ? refFor(skill) : null;
      return ref ? [ref] : [];
    }));
  }

  async function selectExternal(skill: ExternalSkill) {
    const key = `${skill.owner}/${skill.slug}`;
    setBusy(key);
    setMessage(null);
    try {
      const downloaded = await api.download(skill.owner, skill.slug, skill.latest_version);
      if (!downloaded) return;
      if (downloaded.status !== "published") {
        setMessage("技能已下载到内部市场，当前自动开放已关闭；开放后才能绑定专家。");
        return;
      }
      const ref = { skill_id: downloaded.skill_id, version: downloaded.version, content_hash: downloaded.content_hash };
      onChange([...value.filter((item) => item.skill_id !== ref.skill_id), ref]);
      setInternal(await api.listInternal());
      setMessage(`已导入并选择 ${skill.display_name || skill.slug}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "技能导入失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <VStack gap={3}>
      <Heading level={3}>技能（可选）</Heading>
      {message && <Banner status="info" title={message} />}
      <TabList aria-label="专家技能来源" value={tab} onChange={(next) => setTab(next as typeof tab)} hasDivider>
        <Tab value="internal" label="内部技能市场" />
        <Tab value="external" label="ClawHub 外部市场" />
      </TabList>
      {tab === "internal" ? (
        <MultiSelector
          label="选择内部技能"
          options={available.map((skill) => ({ value: skill.skill_id, label: `${skill.display_name || skill.slug} · v${skill.published_version}` }))}
          value={selectedIds}
          onChange={selectInternal}
          placeholder={loading ? "加载中" : "选择已开放技能"}
          triggerDisplay="labels"
          isDisabled={disabled || loading}
        />
      ) : (
        <VStack gap={3}>
          <TextInput label="搜索 ClawHub" value={query} onChange={setQuery} placeholder="输入技能名称或用途" isDisabled={disabled} />
          {external.map((skill) => {
            const key = `${skill.owner}/${skill.slug}`;
            const inside = internal.find((item) => item.owner === skill.owner && item.slug === skill.slug);
            const selected = inside ? selectedIds.includes(inside.skill_id) : false;
            return (
              <Card key={key} padding={3}>
                <HStack justify="between" align="start" wrap="wrap">
                  <VStack gap={1}>
                    <Text weight="bold">{skill.display_name || skill.slug}</Text>
                    <Text color="secondary">{skill.summary || "暂无描述"}</Text>
                    <Text color="secondary">{key} · v{skill.latest_version ?? "未知"}</Text>
                  </VStack>
                  <HStack gap={2}>
                    {selected && <Badge label="已选择" variant="success" />}
                    <Button label="详情" href={skill.canonical_url} variant="ghost" size="sm" />
                    <Button label={inside ? "更新并选择" : "下载并选择"} size="sm" isDisabled={disabled || selected} isLoading={busy === key} onClick={() => void selectExternal(skill)} />
                  </HStack>
                </HStack>
              </Card>
            );
          })}
        </VStack>
      )}
    </VStack>
  );
}
