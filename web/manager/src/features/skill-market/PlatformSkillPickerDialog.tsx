/**
 * 「新增技能 → 添加平台技能」：从运营端开放的平台技能里选，添加到企业技能列表。
 * 企业端只有一个技能列表（来源列区分平台 / 自定义 / ClawHub…），不再单独展示「平台技能市场」。
 * 已添加的显示「已添加」；平台有新版本的显示「更新」（原地更新，同 skill_id，开关与专家配置保留）。
 * 添加后对话框不关，可以连续添加。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, CapabilityOrigin, capabilityTitle } from "@aiteam/shared";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { countSkillUpdates, reportCapabilityUpdates } from "../capability-updates";
import type { PlatformSkillMarketItem } from "./types";
import { useSkillMarketApi } from "./useSkillMarketApi";

export function platformSkillTitle(item: PlatformSkillMarketItem): string {
  return capabilityTitle(item.namespace, item.display_name || item.slug);
}

function matches(item: PlatformSkillMarketItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.display_name, item.slug, item.summary, item.owner, item.namespace].some((text) => (text ?? "").toLowerCase().includes(q));
}

export function PlatformSkillPickerDialog({ onClose, onChanged }: { onClose: () => void; onChanged: (message: string) => void }): ReactNode {
  const api = useSkillMarketApi();
  const [items, setItems] = useState<PlatformSkillMarketItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.list();
      setItems(list);
      reportCapabilityUpdates({ skills: countSkillUpdates(list) });
    } catch (err) {
      setItems((previous) => previous ?? []);
      setError(err instanceof ApiError ? err.message : "平台技能读取失败，请稍后重试");
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => (items ?? []).filter((item) => matches(item, query)), [items, query]);

  async function add(item: PlatformSkillMarketItem) {
    const updating = item.installed && item.update_available;
    setBusy(item.skill_id);
    setError(null);
    setNotice(null);
    try {
      await api.install(item);
      const message = updating
        ? `已把 ${platformSkillTitle(item)} 更新到 v${item.published_version}`
        : `已添加 ${platformSkillTitle(item)} 到企业技能`;
      setNotice(message);
      onChanged(message);
      await load();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "添加失败，请重试");
    } finally {
      setBusy(null);
    }
  }

  const close = (open: boolean) => { if (!open) onClose(); };
  return (
    <Dialog isOpen purpose="form" width={720} aria-label="添加平台技能" onOpenChange={close}>
      <Layout
        header={<DialogHeader title="添加平台技能" onOpenChange={close} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <Text color="secondary">运营端开放的技能。添加后出现在企业技能列表里，来源为「平台市场」；默认成员可以自己安装，可在「编辑」里改为仅配给专家。</Text>
              <TextInput label="搜索平台技能" isLabelHidden placeholder="按名称、说明搜索" value={query} onChange={setQuery} width="100%" />
              {notice && <Banner status="success" title={notice} />}
              {error && <Banner status="error" title={error} />}
              {items === null ? (
                <VStack gap={2} role="status" aria-label="正在读取平台技能"><Skeleton height={56} /><Skeleton height={56} index={1} /></VStack>
              ) : visible.length === 0 ? (
                <EmptyState title={items.length === 0 ? "运营端还没有开放技能" : "没有匹配的技能"} isCompact />
              ) : (
                <ul aria-label="平台技能" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                  {visible.map((item) => {
                    const update = item.installed && item.update_available;
                    return (
                      <li key={item.skill_id} style={{ border: "1px solid var(--astryx-color-border, rgba(127,127,127,.25))", borderRadius: 8, padding: "10px 12px" }}>
                        <HStack justify="between" align="start" gap={3}>
                          <VStack gap={1} style={{ flex: "1 1 auto", minWidth: 0 }}>
                            <Text weight="semibold" style={{ overflowWrap: "anywhere" }}>{platformSkillTitle(item)}</Text>
                            <Text size="sm" color="secondary" style={{ overflowWrap: "anywhere" }}>{item.summary || "暂无说明"}</Text>
                            <HStack gap={2} align="center" wrap="wrap">
                              <Text size="sm" color="secondary">版本 {item.published_version}</Text>
                              <CapabilityOrigin provenance={item.provenance} />
                            </HStack>
                          </VStack>
                          <HStack gap={2} align="center" style={{ flexShrink: 0 }}>
                            {update && <Badge label="平台有新版本" variant="warning" />}
                            <Button
                              label={update ? "更新" : item.installed ? "已添加" : "添加"}
                              size="sm"
                              variant={item.installed && !update ? "ghost" : "primary"}
                              isDisabled={(item.installed && !update) || (busy !== null && busy !== item.skill_id)}
                              isLoading={busy === item.skill_id}
                              aria-label={`${update ? "更新" : item.installed ? "已添加" : "添加"} ${platformSkillTitle(item)}`}
                              onClick={() => void add(item)}
                            />
                          </HStack>
                        </HStack>
                      </li>
                    );
                  })}
                </ul>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack justify="end"><Button label="完成" variant="primary" onClick={onClose} /></HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
