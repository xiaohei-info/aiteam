import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, CapabilityOrigin, capabilityTitle } from "@aiteam/shared";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useSkillMarketApi } from "./useSkillMarketApi";
import type { PlatformSkillMarketItem } from "./types";
import { countSkillUpdates, reportCapabilityUpdates } from "../capability-updates";

/** 平台技能市场：运营端审核开放的技能。`embedded` 时嵌在「技能管理」的标签页里，不显示页标题。 */
export function SkillMarketPage({ embedded = false }: { embedded?: boolean } = {}): ReactNode {
  const api = useSkillMarketApi();
  const [items, setItems] = useState<PlatformSkillMarketItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.list();
      setItems(list);
      reportCapabilityUpdates({ skills: countSkillUpdates(list) });
    }
    catch (err) { setError(err instanceof ApiError ? err.message : "平台技能市场加载失败"); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  async function install(item: PlatformSkillMarketItem) {
    setBusy(item.skill_id);
    setNotice(null);
    try {
      await api.install(item);
      setNotice(`${item.display_name || item.slug} 已安装到企业技能库`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "技能安装失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <VStack as="section" gap={5}>
      {!embedded && <Heading level={1}>技能市场</Heading>}
      <Text color="secondary">运营端审核并开放的技能。安装后出现在「企业技能」里，成员即可自行安装。</Text>
      {notice && <Banner status="success" title={notice} />}
      {error && <Banner status="error" title={error} />}
      {items.length === 0 ? <EmptyState title="暂无平台开放技能" /> : (
        <VStack gap={3}>
          {items.map((item) => (
            <Card key={item.skill_id} padding={4}>
              <HStack justify="between" align="start" wrap="wrap" gap={3}>
                <VStack gap={1} style={{ flex: "1 1 320px", minWidth: 0 }}>
                  <Heading level={3}>{item.display_name || item.slug}</Heading>
                  <Text color="secondary">{item.summary || "暂无描述"}</Text>
                  <Text color="secondary">{capabilityTitle(item.namespace, item.slug)} · v{item.published_version}</Text>
                  <CapabilityOrigin provenance={item.provenance} />
                </VStack>
                <HStack gap={2} style={{ flexShrink: 0 }}>
                  {item.installed && <Badge label={item.update_available ? "可更新" : "已安装"} variant={item.update_available ? "warning" : "success"} />}
                  <Button
                    label={item.installed ? item.update_available ? "更新" : "已安装" : "安装"}
                    size="sm"
                    isDisabled={item.installed && !item.update_available}
                    isLoading={busy === item.skill_id}
                    onClick={() => void install(item)}
                  />
                </HStack>
              </HStack>
            </Card>
          ))}
        </VStack>
      )}
    </VStack>
  );
}
