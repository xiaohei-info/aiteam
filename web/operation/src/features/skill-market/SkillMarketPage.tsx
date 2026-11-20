import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Switch } from "@astryxdesign/core/Switch";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { ClawHubLinkImport, SecurityBadges, SkillPreviewDialog } from "./SkillMarketParts";
import { errorText, useExternalSkills } from "./useExternalSkills";
import { useSkillMarketApi } from "./useSkillMarketApi";
import type { ExternalSkillPreview, InternalSkill } from "./types";

export function SkillMarketPage(): ReactNode {
  const api = useSkillMarketApi();
  const [tab, setTab] = useState<"internal" | "external">("internal");
  const [internal, setInternal] = useState<InternalSkill[]>([]);
  const [internalLoading, setInternalLoading] = useState(true);
  const [internalError, setInternalError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [autoPublish, setAutoPublish] = useState(true);
  const [previewing, setPreviewing] = useState<{ owner: string; slug: string } | null>(null);
  const external = useExternalSkills(api, query, tab === "external");

  // 内部目录只读本库，和 ClawHub 是否可用无关，单独加载。
  const loadInternal = useCallback(async () => {
    setInternalError(null);
    try {
      setInternal(await api.listInternal());
    } catch (err) {
      setInternalError(errorText(err, "内部技能市场加载失败"));
    } finally {
      setInternalLoading(false);
    }
  }, [api]);

  useEffect(() => { void loadInternal(); }, [loadInternal]);
  useEffect(() => {
    api.getSettings().then((settings) => setAutoPublish(settings.auto_publish_downloads)).catch(() => undefined);
  }, [api]);

  async function setStatus(skill: InternalSkill, publish: boolean): Promise<void> {
    setBusy(skill.skill_id);
    setNotice(null);
    setError(null);
    try {
      if (publish) await api.publish(skill.skill_id); else await api.unpublish(skill.skill_id);
      setNotice(`${skill.display_name || skill.slug} 已${publish ? "开放" : "下架"}`);
      await loadInternal();
    } catch (err) {
      setError(errorText(err, "技能状态更新失败"));
    } finally {
      setBusy(null);
    }
  }

  async function importPreview(preview: ExternalSkillPreview): Promise<void> {
    const imported = await api.download(preview.owner, preview.slug, preview.version);
    setPreviewing(null);
    const skipped = imported?.skipped?.length ? `，跳过 ${imported.skipped.length} 个文件` : "";
    const state = imported?.status === "published" ? "已开放" : "待开放";
    setNotice(`已导入 ${preview.display_name} v${preview.version}（${state}${skipped}）`);
    await loadInternal();
  }

  return (
    <VStack as="section" gap={5}>
      <Heading level={1}>技能市场</Heading>
      {notice && <Banner status="success" title={notice} />}
      {error && <Banner status="error" title={error} />}
      <Switch
        label="下载后自动开放"
        description="默认开启；关闭后新下载版本进入待开放状态，Manager 暂不可见。"
        value={autoPublish}
        onChange={(value) => {
          setAutoPublish(value);
          void api.setSettings(value).catch(() => setError("自动开放设置保存失败"));
        }}
      />
      <TabList aria-label="技能市场来源" value={tab} onChange={(value) => setTab(value as typeof tab)} hasDivider>
        <Tab value="internal" label="内部技能市场" />
        <Tab value="external" label="ClawHub 外部市场" />
      </TabList>
      {tab === "internal" ? (
        internalError ? <Banner status="error" title={internalError} endContent={<Button label="重试" variant="ghost" size="sm" onClick={() => void loadInternal()} />} />
          : internalLoading ? <HStack gap={2} align="center"><Spinner size="sm" /><Text color="secondary">加载中…</Text></HStack>
            : internal.length === 0 ? <EmptyState title="暂无内部技能" description="到「ClawHub 外部市场」预览并导入。" /> : (
              <VStack gap={3}>
                {internal.map((skill) => (
                  <Card key={skill.skill_id} padding={4}>
                    <HStack justify="between" align="start" wrap="wrap" gap={3}>
                      <VStack gap={1}>
                        <Heading level={3}>{skill.display_name || skill.slug}</Heading>
                        <Text color="secondary">{skill.summary || "暂无描述"}</Text>
                        <Text color="secondary">{skill.owner}/{skill.slug} · v{skill.latest_internal_version}</Text>
                        <HStack gap={2} wrap="wrap"><SecurityBadges security={skill.security} /></HStack>
                      </VStack>
                      <HStack gap={2}>
                        <Badge
                          label={skill.latest_version_status === "draft" ? "新版待开放" : skill.status === "published" ? "已开放" : skill.status === "draft" ? "待开放" : "已下架"}
                          variant={skill.latest_version_status === "draft" ? "warning" : skill.status === "published" ? "success" : "warning"}
                        />
                        <Button
                          label={skill.latest_version_status === "draft" || skill.status !== "published" ? "开放" : "下架"}
                          size="sm"
                          variant={skill.latest_version_status !== "draft" && skill.status === "published" ? "destructive" : "primary"}
                          isLoading={busy === skill.skill_id}
                          onClick={() => void setStatus(skill, skill.latest_version_status === "draft" || skill.status !== "published")}
                        />
                      </HStack>
                    </HStack>
                  </Card>
                ))}
              </VStack>
            )
      ) : (
        <VStack gap={3}>
          <TextInput label="搜索 ClawHub 技能" value={query} onChange={setQuery} placeholder="输入技能名称或用途" isOptional />
          <ClawHubLinkImport api={api} onPick={(owner, slug) => setPreviewing({ owner, slug })} />
          <Text type="supporting">ClawHub 的安全扫描结论在预览里查看，只作提示，不影响导入。技能可能带脚本，员工运行命令仍按企业审批策略执行。</Text>
          {external.error && <Banner status="error" title={external.error} endContent={<Button label="重试" variant="ghost" size="sm" onClick={external.retry} />} />}
          {external.loading ? <HStack gap={2} align="center"><Spinner size="sm" /><Text color="secondary">正在读取 ClawHub…</Text></HStack>
            : !external.error && external.items.length === 0 ? <EmptyState title="暂无匹配技能" /> : (
              <VStack gap={3}>
                {external.items.map((skill) => {
                  const inside = internal.find((item) => item.owner === skill.owner && item.slug === skill.slug);
                  const current = Boolean(inside && skill.latest_version && inside.latest_internal_version === skill.latest_version);
                  // 搜索结果不带版本，无法判断是否有新版，只有已知不同才提示更新。
                  const newer = Boolean(inside && skill.latest_version && !current);
                  return (
                    <Card key={`${skill.owner}/${skill.slug}`} padding={4}>
                      <HStack justify="between" align="start" wrap="wrap" gap={3}>
                        <VStack gap={1}>
                          <Heading level={3}>{skill.display_name || skill.slug}</Heading>
                          <Text color="secondary">{skill.summary || "暂无描述"}</Text>
                          <Text color="secondary">{skill.owner}/{skill.slug}{skill.latest_version ? ` · v${skill.latest_version}` : ""}</Text>
                        </VStack>
                        <HStack gap={2}>
                          {inside && <Badge label={current ? "已导入" : `已导入 v${inside.latest_internal_version}`} variant={current ? "success" : "info"} />}
                          <Button label="详情" href={skill.canonical_url} variant="ghost" size="sm" />
                          <Button label={newer ? "预览更新" : "预览"} variant="primary" size="sm" onClick={() => setPreviewing({ owner: skill.owner, slug: skill.slug })} />
                        </HStack>
                      </HStack>
                    </Card>
                  );
                })}
                {external.hasMore && <Button label="加载更多" onClick={() => void external.loadMore()} isLoading={external.loadingMore} />}
              </VStack>
            )}
        </VStack>
      )}
      {previewing && (
        <SkillPreviewDialog
          api={api}
          owner={previewing.owner}
          slug={previewing.slug}
          confirmLabel="导入"
          onConfirm={importPreview}
          onClose={() => setPreviewing(null)}
        />
      )}
    </VStack>
  );
}
