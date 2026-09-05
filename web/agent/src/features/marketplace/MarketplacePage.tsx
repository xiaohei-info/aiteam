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
import { DigitalEmployeeAvatar } from "@aiteam/shared";
import { useApp } from "../../lib/app-context";
import { listTemplates } from "./useMarketplaceApi";
import type { MarketTemplate } from "./types";

export function MarketplacePage() {
  const { client, i18n } = useApp();
  const [templates, setTemplates] = useState<MarketTemplate[]>([]);
  const [categories, setCategories] = useState<string[]>(["全部"]);
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("全部");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const list = await listTemplates(client);
      const normalizedKeyword = keyword.trim().toLocaleLowerCase();
      const filtered = list.filter((template) => {
        const matchesCategory = category === "全部" || template.category === category;
        const searchable = [template.display_name, template.category, ...template.tags].join(" ").toLocaleLowerCase();
        return matchesCategory && (!normalizedKeyword || searchable.includes(normalizedKeyword));
      });
      setTemplates(filtered);
      // 分类来自后端真实模板（Manager 端招募到的专家分类），不再写死。
      if (category === "全部" && !normalizedKeyword) {
        const cats = Array.from(new Set(list.map((t) => t.category).filter(Boolean)));
        setCategories(["全部", ...cats]);
      }
    } catch (err) { setError(err instanceof ApiError ? err.message : i18n.t("agent.workspace.load_error")); }
    finally { setLoading(false); }
  }, [client, i18n, keyword, category]);

  useEffect(() => { void load(); }, [load]);

  return (
    <VStack gap={4} role="region" aria-label="人才市场">
      <HStack justify="between" align="center" wrap="wrap">
        <VStack gap={1}>
          <Heading level={1}>人才市场</Heading>
          <Text type="supporting">用户端只读取 Agent API 提供的目录投影；招募与发布由 Manager/Operation 管理。</Text>
        </VStack>
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

      {loading ? <Banner status="info" title="加载中…" /> :
        error ? <Banner status="error" title={error} /> :
        templates.length === 0 ? <EmptyState title="人才市场暂无可用目录" description="当前 Agent 没有收到可读取的目录投影，请在 Manager/Operation 配置后重试。" data-testid="marketplace-empty" /> :
        <HStack gap={3} wrap="wrap">
          {templates.map((t) => (
            <Card key={t.template_id} padding={3} width={280}>
              <VStack gap={2}>
                <HStack gap={2} align="center">
                  <DigitalEmployeeAvatar name={t.display_name} seed={t.template_id} src={t.avatar_url} size={52} />
                  <VStack gap={0}>
                    <Text weight="semibold">{t.display_name}</Text>
                    <Text type="supporting">{t.category}</Text>
                  </VStack>
                </HStack>
                <Text type="supporting">{t.model_name} · {t.skills_count} Skills</Text>
                {t.tags.length > 0 && <HStack gap={1} wrap="wrap">{t.tags.slice(0, 3).map((tag) => <Badge key={tag} label={tag} />)}</HStack>}
                {t.recruit_count != null && <Text type="supporting">已记录 {t.recruit_count} 次招募</Text>}
                {t.is_recruited ? <Badge variant="success" label="✓ 已招募" /> :
                  <Text type="supporting">请在 Manager 端配置</Text>}
              </VStack>
            </Card>
          ))}
        </HStack>}
    </VStack>
  );
}
