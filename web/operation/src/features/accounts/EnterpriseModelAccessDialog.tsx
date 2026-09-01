import { useEffect, useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { HStack } from "@astryxdesign/core/HStack";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { usePlatformProvidersApi } from "../providers/usePlatformProvidersApi";
import type { PlatformModelRef } from "../catalog/types";
import type { EnterpriseAccount, EnterpriseModelAccess } from "./types";
import type { AccountsApi } from "./useAccountsApi";

interface ModelOption {
  value: string;
  label: string;
  ref: PlatformModelRef;
}

interface Props {
  enterprise: EnterpriseAccount;
  api: AccountsApi;
  onClose: () => void;
  onDone: () => void;
}

export function EnterpriseModelAccessDialog({ enterprise, api, onClose, onDone }: Props): ReactNode {
  const providerApi = usePlatformProvidersApi();
  const [options, setOptions] = useState<ModelOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [allowAll, setAllowAll] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    if (!api.getModelAccess) {
      setError("企业模型开放配置接口不可用");
      setLoaded(false);
      setLoading(false);
      return () => { active = false; };
    }
    const getModelAccess = api.getModelAccess;
    void Promise.all([
      providerApi.list().then(async (providers) => {
        const published = providers.filter((provider) => provider.status === "published");
        const groups = await Promise.all(
          published.map(async (provider) => ({ provider, models: await providerApi.models(provider.provider_id) })),
        );
        const next: ModelOption[] = [];
        for (const { provider, models } of groups) {
          for (const item of models) {
            if (item.model.status !== "published" || item.rate?.pricing_status !== "known") continue;
            next.push({
              value: `${provider.provider_id}::${item.model.model_id}`,
              label: `${provider.display_name} / ${item.model.display_name || item.model.model_id}`,
              ref: {
                provider_id: provider.provider_id,
                provider_version: provider.version,
                model_id: item.model.model_id,
                model_version: item.model.version,
              },
            });
          }
        }
        return next;
      }),
      getModelAccess(enterprise.org_id),
    ]).then(([nextOptions, access]) => {
      if (!active) return;
      const modelAccess = access as EnterpriseModelAccess | null;
      if (!modelAccess) throw new Error("企业模型开放配置为空");
      const unrestricted = modelAccess.allowed_model_refs == null;
      setOptions(nextOptions);
      setAllowAll(unrestricted);
      if (unrestricted) {
        setSelected(nextOptions.map((option) => option.value));
      } else {
        const allowed = new Set((modelAccess?.allowed_model_refs ?? []).map((ref) => `${ref.provider_id}::${ref.model_id}`));
        setSelected(nextOptions.filter((option) => allowed.has(option.value)).map((option) => option.value));
      }
      setError(null);
      setLoaded(true);
    }).catch((cause) => {
      if (active) {
        setLoaded(false);
        setError(cause instanceof Error ? cause.message : "模型目录加载失败");
      }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [api, enterprise.org_id, providerApi]);

  async function save(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const refs = allowAll
        ? null
        : options.filter((option) => selected.includes(option.value)).map((option) => option.ref);
      if (!api.setModelAccess) throw new Error("企业模型开放配置接口不可用");
      await api.setModelAccess(enterprise.org_id, refs);
      onDone();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "企业模型开放配置保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  function toggleAllowAll(value: boolean): void {
    setAllowAll(value);
    if (value) setSelected(options.map((option) => option.value));
  }

  return (
    <Dialog
      isOpen
      purpose="form"
      width={680}
      aria-label={`配置${enterprise.enterprise_name}可用模型`}
      onOpenChange={(open) => { if (!open && !submitting) onClose(); }}
      data-testid="enterprise-model-access-dialog"
    >
      <Layout
        height="auto"
        header={<DialogHeader title={`配置${enterprise.enterprise_name}可用模型`} onOpenChange={(open) => { if (!open && !submitting) onClose(); }} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <Text color="secondary">Manager 招募或编辑专家时，只能使用下面开放的模型；未开放模型会按不存在处理。</Text>
              {error && <Banner status="error" title={error} />}
              <Card variant="muted" padding={3}>
                <VStack gap={3}>
                  <CheckboxInput label="开放全部已发布模型" value={allowAll} onChange={toggleAllowAll} isDisabled={submitting || loading} />
                  <MultiSelector
                    label="开放模型列表"
                    options={options.map((option) => ({ value: option.value, label: option.label }))}
                    value={selected}
                    onChange={setSelected}
                    placeholder={loading ? "模型目录加载中…" : options.length ? "选择开放模型" : "暂无已发布模型"}
                    isDisabled={submitting || loading || allowAll || options.length === 0}
                    isLoading={loading}
                    hasSelectAll
                    selectAllLabel="选择全部模型"
                    hasSearch
                    searchPlaceholder="搜索模型"
                    triggerDisplay="labels"
                    data-testid="enterprise-model-access-select"
                  />
                </VStack>
              </Card>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} hAlign="end">
              <Button label="取消" variant="ghost" onClick={onClose} isDisabled={submitting} />
              <Button label="保存开放范围" variant="primary" onClick={() => void save()} isLoading={submitting} isDisabled={loading || !loaded || submitting} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
