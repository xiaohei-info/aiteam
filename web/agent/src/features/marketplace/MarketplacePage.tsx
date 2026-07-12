/** P03 人才市场页 — 专家浏览/招募 + 发布需求/上架智能体入口（demo 对齐：AI-Team-Demo.html:1265-1266）。 */
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useApp } from "../../lib/app-context";
import { listTemplates, recruit } from "./useMarketplaceApi";
import type { MarketTemplate } from "./types";

export function MarketplacePage() {
  const { client, i18n } = useApp();
  const [templates, setTemplates] = useState<MarketTemplate[]>([]);
  const [categories, setCategories] = useState<string[]>(["全部"]);
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("全部");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [recruiting, setRecruiting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const list = await listTemplates(client, { keyword: keyword || undefined, category: category !== "全部" ? category : undefined });
      setTemplates(list);
      // 分类来自后端真实模板（Manager 端招募到的专家分类），不再写死。
      // 仅在全量视图（无分类、无关键字过滤）刷新分类栏，保证选中某分类后栏位稳定。
      if (category === "全部" && !keyword) {
        const cats = Array.from(new Set(list.map((t) => t.category).filter(Boolean)));
        setCategories(["全部", ...cats]);
      }
    } catch (err) { setError(err instanceof ApiError ? err.message : i18n.t("agent.workspace.load_error")); }
    finally { setLoading(false); }
  }, [client, i18n, keyword, category]);

  useEffect(() => { void load(); }, [load]);

  const handleRecruit = useCallback(async (templateId: string) => {
    setRecruiting(templateId); setActionError(null);
    try { await recruit(client, templateId); await load(); } catch (errRecruit) { setActionError(errRecruit instanceof ApiError ? errRecruit.message : "招募失败"); } finally { setRecruiting(null); }
  }, [client, load]);

  const handlePublishRequirement = useCallback(() => {
    setActionError(null);
    setActionInfo(i18n.t("agent.marketplace.publish_requirement_hint"));
  }, [i18n]);

  const handleListMyAgent = useCallback(() => {
    setActionError(null);
    setActionInfo(i18n.t("agent.marketplace.list_my_agent_hint"));
  }, [i18n]);

  return (
    <VStack gap={4} role="region" aria-label="人才市场">
      <HStack justify="between" align="center" wrap="wrap">
        <Heading level={1}>人才市场</Heading>
        <HStack gap={1}>
          <Button label={i18n.t("agent.marketplace.publish_requirement")} variant="secondary" onClick={() => void handlePublishRequirement()} />
          <Button label={i18n.t("agent.marketplace.list_my_agent")} variant="primary" onClick={() => void handleListMyAgent()} />
        </HStack>
      </HStack>

      <HStack gap={2} align="end">
        <TextInput label="搜索专家名称、技能" isLabelHidden placeholder="搜索专家名称、技能…" value={keyword} onChange={setKeyword} width="100%" />
        <Button label="搜索" variant="secondary" onClick={() => void load()} />
      </HStack>

      <HStack gap={1} wrap="wrap">
        {categories.map((c) => (
          <Button key={c} label={c} variant={category === c ? "primary" : "secondary"} size="sm" onClick={() => setCategory(c)} />
        ))}
      </HStack>

      {actionError && <Banner status="error" title={actionError} />}
      {actionInfo && <Banner status="info" title={actionInfo} />}

      {loading ? <Banner status="info" title="加载中…" /> :
        error ? <Banner status="error" title={error} /> :
        templates.length === 0 ? <EmptyState title="暂无可招募专家" /> :
        <HStack gap={3} wrap="wrap">
          {templates.map((t) => (
            <Card key={t.template_id} padding={3} width={280}>
              <VStack gap={2}>
                <Text weight="semibold">{t.display_name}</Text>
                <Text type="supporting">{t.category} · {t.model_name} · {t.skills_count} Skills</Text>
                {t.tags.length > 0 && <HStack gap={1} wrap="wrap">{t.tags.slice(0, 3).map((tag) => <Badge key={tag} label={tag} />)}</HStack>}
                <Text type="supporting">已有 {t.recruit_count} 家企业招募</Text>
                {t.is_recruited ? <Badge variant="success" label="✓ 已招募" /> :
                  <Button label="招募" variant="primary" size="sm" isLoading={recruiting === t.template_id} onClick={() => void handleRecruit(t.template_id)} />}
              </VStack>
            </Card>
          ))}
        </HStack>}
    </VStack>
  );
}
