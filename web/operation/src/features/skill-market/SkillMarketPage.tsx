import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Switch } from "@astryxdesign/core/Switch";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useSkillMarketApi } from "./useSkillMarketApi";
import type { ExternalSkill, InternalSkill } from "./types";

export function SkillMarketPage(): ReactNode {
  const api = useSkillMarketApi();
  const [tab, setTab] = useState<"internal" | "external">("internal");
  const [internal, setInternal] = useState<InternalSkill[]>([]);
  const [external, setExternal] = useState<ExternalSkill[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [autoPublish, setAutoPublish] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [inside, outside, settings] = await Promise.all([api.listInternal(), api.listExternal(query.trim() || undefined), api.getSettings()]);
      setInternal(inside);
      setExternal(outside);
      setAutoPublish(settings.auto_publish_downloads);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "技能市场加载失败");
    }
  }, [api, query]);

  useEffect(() => { void load(); }, [load]);

  async function setStatus(skill: InternalSkill, publish: boolean): Promise<void> {
    setBusy(skill.skill_id);
    setNotice(null);
    try {
      if (publish) await api.publish(skill.skill_id); else await api.unpublish(skill.skill_id);
      setNotice(`${skill.display_name || skill.slug} 已${publish ? "开放" : "下架"}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "技能状态更新失败");
    } finally {
      setBusy(null);
    }
  }

  async function download(skill: ExternalSkill): Promise<void> {
    const key = `${skill.owner}/${skill.slug}`;
    setBusy(key);
    setNotice(null);
    try {
      await api.download(skill.owner, skill.slug, skill.latest_version);
      setNotice(`已导入 ${skill.display_name || skill.slug} 到内部技能市场`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "技能下载失败");
    } finally {
      setBusy(null);
    }
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
      {tab === "external" && (
        <TextInput label="搜索 ClawHub 技能" value={query} onChange={setQuery} placeholder="输入技能名称或用途" />
      )}
      {tab === "internal" ? (
        internal.length === 0 ? <EmptyState title="暂无内部技能" /> : (
          <VStack gap={3}>
            {internal.map((skill) => (
              <Card key={skill.skill_id} padding={4}>
                <HStack justify="between" align="start" wrap="wrap">
                  <VStack gap={1}>
                    <Heading level={3}>{skill.display_name || skill.slug}</Heading>
                    <Text color="secondary">{skill.summary || "暂无描述"}</Text>
                    <Text color="secondary">{skill.owner}/{skill.slug} · v{skill.latest_internal_version}</Text>
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
      ) : external.length === 0 ? <EmptyState title="暂无匹配技能" /> : (
        <VStack gap={3}>
          {external.map((skill) => {
            const inside = internal.find((item) => item.owner === skill.owner && item.slug === skill.slug);
            const current = Boolean(inside && inside.latest_internal_version === skill.latest_version);
            return (
              <Card key={`${skill.owner}/${skill.slug}`} padding={4}>
                <HStack justify="between" align="start" wrap="wrap">
                  <VStack gap={1}>
                    <Heading level={3}>{skill.display_name || skill.slug}</Heading>
                    <Text color="secondary">{skill.summary || "暂无描述"}</Text>
                    <Text color="secondary">{skill.owner}/{skill.slug} · v{skill.latest_version ?? "未知"}</Text>
                  </VStack>
                  <HStack gap={2}>
                    {inside && <Badge label={current ? "已下载" : "可更新"} variant={current ? "success" : "warning"} />}
                    <Button label="详情" href={skill.canonical_url} variant="ghost" size="sm" />
                    <Button label={current ? "已下载" : inside ? "更新" : "下载"} variant="primary" size="sm" isDisabled={current} isLoading={busy === `${skill.owner}/${skill.slug}`} onClick={() => void download(skill)} />
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
