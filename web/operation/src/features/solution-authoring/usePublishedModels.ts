/** 可用于生成的模型：已发布、有价格的平台模型（与专家模板注册页同一口径）。 */
import { isSelectablePlatformModel } from "@aiteam/shared";
import { useEffect, useState } from "react";
import { usePlatformProvidersApi } from "../providers/usePlatformProvidersApi";
import type { ModelRef } from "./types";

export interface ModelOption {
  value: string;
  label: string;
  ref: ModelRef;
  supportsImages: boolean;
}

export interface PublishedModels {
  options: ModelOption[];
  loading: boolean;
  error: string | null;
}

export function usePublishedModels(enabled: boolean): PublishedModels {
  const api = usePlatformProvidersApi();
  const [state, setState] = useState<PublishedModels>({ options: [], loading: false, error: null });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ options: [], loading: true, error: null });
    void (async () => {
      try {
        const providers = (await api.list()).filter((provider) => provider.status === "published");
        const groups = await Promise.all(providers.map(async (provider) => ({ provider, models: await api.models(provider.provider_id) })));
        const options: ModelOption[] = [];
        for (const { provider, models } of groups) {
          for (const item of models) {
            if (!isSelectablePlatformModel(item)) continue;
            const input = item.model.capabilities.input;
            const supportsImages = Array.isArray(input) && input.includes("image");
            options.push({
              value: `${provider.provider_id}::${item.model.model_id}`,
              label: `${provider.display_name} / ${item.model.model_id}${supportsImages ? " · 支持图片" : ""}`,
              ref: { provider_id: provider.provider_id, model_id: item.model.model_id },
              supportsImages,
            });
          }
        }
        if (!cancelled) setState({ options, loading: false, error: null });
      } catch (err) {
        if (!cancelled) setState({ options: [], loading: false, error: err instanceof Error ? err.message : "模型列表加载失败" });
      }
    })();
    return () => { cancelled = true; };
  }, [api, enabled]);

  return state;
}
