/** 发布范围弹窗：全部企业 / 指定行业或标签，底部实时显示预计可见企业数。发布与「调整范围」共用。 */
import { useEffect, useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { normalizeScope, type VisibleScope } from "./types";
import { useCatalogApi } from "./useCatalogApi";

interface Props {
  title: string;
  confirmLabel: string;
  /** 当前范围（调整时传已有值，发布时不传 = 全部企业）。 */
  initial?: unknown;
  onConfirm: (scope: VisibleScope) => Promise<void>;
  onClose: () => void;
}

function union(options: string[], current: string[]): Array<{ value: string; label: string }> {
  return [...new Set([...options, ...current])].map((value) => ({ value, label: value }));
}

export function ScopeDialog({ title, confirmLabel, initial, onConfirm, onClose }: Props): ReactNode {
  const api = useCatalogApi();
  const start = normalizeScope(initial);
  const [mode, setMode] = useState<VisibleScope["mode"]>(start.mode);
  const [industries, setIndustries] = useState<string[]>(start.industries);
  const [tags, setTags] = useState<string[]>(start.tags);
  const [options, setOptions] = useState<{ industries: string[]; tags: string[] }>({ industries: [], tags: [] });
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scope: VisibleScope = mode === "all" ? { mode, industries: [], tags: [] } : { mode, industries, tags };
  const incomplete = mode === "limited" && industries.length === 0 && tags.length === 0;

  useEffect(() => {
    let active = true;
    api.scopeOptions().then((value) => { if (active) setOptions(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (incomplete) { setCount(null); return; }
    let active = true;
    api.scopePreview(scope).then((value) => { if (active) setCount(value); }).catch(() => { if (active) setCount(null); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, mode, industries, tags, incomplete]);

  async function submit(): Promise<void> {
    if (incomplete) { setError("请至少选择一个行业或标签"); return; }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(scope);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "操作失败");
      setBusy(false);
    }
  }

  const close = () => { if (!busy) onClose(); };

  return (
    <Dialog isOpen onOpenChange={(open) => { if (!open) close(); }} purpose="form" width={520} aria-label={title}>
      <Layout
        header={<DialogHeader title={title} onOpenChange={(open) => { if (!open) close(); }} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <SegmentedControl label="发布范围" value={mode} onChange={(value) => setMode(value as VisibleScope["mode"])}>
                <SegmentedControlItem value="all" label="全部企业" />
                <SegmentedControlItem value="limited" label="指定行业或标签" />
              </SegmentedControl>
              {mode === "limited" && (
                <>
                  <Text color="secondary">企业的行业命中其中之一，或带有任一标签，即可看到。</Text>
                  <MultiSelector
                    label="行业"
                    options={union(options.industries, industries)}
                    value={industries}
                    onChange={setIndustries}
                    placeholder={options.industries.length ? "选择行业" : "暂无企业填写行业"}
                    isOptional
                    hasSearch
                    triggerDisplay="labels"
                    data-testid="scope-industries"
                  />
                  <MultiSelector
                    label="标签"
                    options={union(options.tags, tags)}
                    value={tags}
                    onChange={setTags}
                    placeholder={options.tags.length ? "选择标签" : "暂无企业填写标签"}
                    isOptional
                    hasSearch
                    triggerDisplay="labels"
                    data-testid="scope-tags"
                  />
                </>
              )}
              <Text color="secondary" data-testid="scope-preview">
                {count === null ? "预计可见企业：—" : `预计可见企业：${count} 家`}
              </Text>
              {error && <Banner status="error" title={error} />}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} hAlign="end">
              <Button label="取消" variant="ghost" onClick={close} isDisabled={busy} />
              <Button label={confirmLabel} variant="primary" onClick={() => void submit()} isLoading={busy} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
