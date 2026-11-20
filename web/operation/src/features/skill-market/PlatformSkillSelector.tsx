/**
 * 平台 skill 选择器：内部技能市场（只列已发布版本）+ ClawHub 外部市场（预览、导入后选择）。
 * 只能选中平台已发布的固定版本；导入后若「自动开放」已关闭，需先在技能市场开放才能选。
 * 目录登记的专家技能与行业文档生成的能力清单共用。
 */
import { useEffect, useState } from "react";
import { Spinner } from "@astryxdesign/core/Spinner";
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
import { ClawHubLinkImport, SkillPreviewDialog } from "./SkillMarketParts";
import { errorText, useExternalSkills } from "./useExternalSkills";
import { useSkillMarketApi } from "./useSkillMarketApi";
import type { ExternalSkillPreview, InternalSkill, PlatformSkillRef } from "./types";

interface PlatformSkillSelectorProps {
  value: PlatformSkillRef[];
  onChange: (value: PlatformSkillRef[]) => void;
  disabled: boolean;
  /** 区块标题；null 不显示（嵌在已有标题的分区里时）。 */
  title?: string | null;
  /** 导入后未开放时的提示里说明「开放后才能……」。 */
  purpose?: string;
}

function refFor(skill: InternalSkill): PlatformSkillRef | null {
  if (!skill.published_version || !skill.content_hash || skill.status !== "published") return null;
  return { skill_id: skill.skill_id, version: skill.published_version, content_hash: skill.content_hash };
}

export function PlatformSkillSelector({ value, onChange, disabled, title = "技能（可选）", purpose = "绑定专家" }: PlatformSkillSelectorProps) {
  const api = useSkillMarketApi();
  const [tab, setTab] = useState<"internal" | "external">("internal");
  const [internal, setInternal] = useState<InternalSkill[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<{ owner: string; slug: string } | null>(null);
  // ClawHub 只在切到外部页签时请求；外部故障不影响选内部技能。
  const external = useExternalSkills(api, query, tab === "external");

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.listInternal()
      .then((inside) => { if (active) setInternal(inside); })
      .catch((error) => { if (active) setMessage(errorText(error, "内部技能市场加载失败")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api]);

  const available = internal.filter((skill) => refFor(skill));
  const selectedIds = value.map((ref) => ref.skill_id);

  function selectInternal(ids: string[]) {
    onChange(ids.flatMap((id) => {
      const skill = available.find((item) => item.skill_id === id);
      const ref = skill ? refFor(skill) : null;
      return ref ? [ref] : [];
    }));
  }

  /** 预览弹窗确认后调用；失败时抛出，由弹窗显示错误。 */
  async function importAndSelect(preview: ExternalSkillPreview) {
    if (preview.imported_version === preview.version) {
      // 平台目录已是该版本：不重复下载，直接选已开放版本。
      const latest = await api.listInternal();
      setInternal(latest);
      setPreviewing(null);
      const existing = latest.find((item) => item.owner === preview.owner && item.slug === preview.slug);
      const ref = existing && existing.published_version === preview.version ? refFor(existing) : null;
      if (!ref) {
        setMessage(`该技能 v${preview.version} 已在内部市场但尚未开放；在技能市场开放后才能${purpose}。`);
        return;
      }
      onChange([...value.filter((item) => item.skill_id !== ref.skill_id), ref]);
      setMessage(`已选择 ${preview.display_name}`);
      return;
    }
    const downloaded = await api.download(preview.owner, preview.slug, preview.version);
    setPreviewing(null);
    setMessage(null);
    setInternal(await api.listInternal());
    if (!downloaded) return;
    if (downloaded.status !== "published") {
      setMessage(`技能已导入内部市场，当前自动开放已关闭；在技能市场开放后才能${purpose}。`);
      return;
    }
    const ref = { skill_id: downloaded.skill_id, version: downloaded.version, content_hash: downloaded.content_hash };
    onChange([...value.filter((item) => item.skill_id !== ref.skill_id), ref]);
    setMessage(`已导入并选择 ${preview.display_name}`);
  }

  function selectCurrent(skill: InternalSkill) {
    const ref = refFor(skill);
    if (ref) onChange([...value.filter((item) => item.skill_id !== ref.skill_id), ref]);
  }

  return (
    <VStack gap={3}>
      {title && <Heading level={3}>{title}</Heading>}
      {message && <Banner status="info" title={message} />}
      <TabList aria-label="技能来源" value={tab} onChange={(next) => setTab(next as typeof tab)} hasDivider>
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
          <TextInput label="搜索 ClawHub" value={query} onChange={setQuery} placeholder="输入技能名称或用途" isOptional isDisabled={disabled} />
          <ClawHubLinkImport api={api} disabled={disabled} onPick={(owner, slug) => setPreviewing({ owner, slug })} />
          {external.error && <Banner status="error" title={external.error} endContent={<Button label="重试" variant="ghost" size="sm" onClick={external.retry} />} />}
          {external.loading && <HStack gap={2} align="center"><Spinner size="sm" /><Text color="secondary">正在读取 ClawHub…</Text></HStack>}
          {!external.loading && !external.error && external.items.length === 0 && <Text color="secondary">暂无匹配技能</Text>}
          {!external.loading && external.items.map((skill) => {
            const key = `${skill.owner}/${skill.slug}`;
            const inside = internal.find((item) => item.owner === skill.owner && item.slug === skill.slug);
            const selected = inside ? selectedIds.includes(inside.skill_id) : false;
            const current = Boolean(inside && skill.latest_version && inside.published_version === skill.latest_version && refFor(inside));
            // 搜索结果不带版本：只有 ClawHub 版本已知且与平台目录不同时才算有更新。
            const newer = Boolean(inside && skill.latest_version && inside.latest_internal_version !== skill.latest_version);
            return (
              <Card key={key} padding={3}>
                <HStack justify="between" align="start" wrap="wrap">
                  <VStack gap={1}>
                    <Text weight="bold">{skill.display_name || skill.slug}</Text>
                    <Text color="secondary">{skill.summary || "暂无描述"}</Text>
                    <Text color="secondary">{key}{skill.latest_version ? ` · v${skill.latest_version}` : ""}</Text>
                  </VStack>
                  <HStack gap={2}>
                    {selected && <Badge label="已选择" variant="success" />}
                    <Button label="详情" href={skill.canonical_url} variant="ghost" size="sm" />
                    {current && inside
                      ? <Button label="选择" size="sm" isDisabled={disabled || selected} onClick={() => selectCurrent(inside)} />
                      : <Button label={newer ? "预览更新" : "预览并选择"} size="sm" isDisabled={disabled || (selected && !newer)} onClick={() => setPreviewing({ owner: skill.owner, slug: skill.slug })} />}
                  </HStack>
                </HStack>
              </Card>
            );
          })}
          {!external.loading && external.hasMore && <Button label="加载更多" onClick={() => void external.loadMore()} isLoading={external.loadingMore} isDisabled={disabled} />}
        </VStack>
      )}
      {previewing && (
        <SkillPreviewDialog
          api={api}
          owner={previewing.owner}
          slug={previewing.slug}
          confirmLabel="导入并选择"
          currentLabel="选择"
          onConfirm={importAndSelect}
          onClose={() => setPreviewing(null)}
        />
      )}
    </VStack>
  );
}
