/**
 * 招募 / 应用方案时可选的平台模型。
 *
 * 模板不再带模型，模型由企业在招募时显式选择；这里只列出本企业可用的
 * （Operator 已发布且价格已知）模型。`/api/manager/platform-models` 已按企业开通过滤。
 */
import { isSelectablePlatformModel } from "@aiteam/shared";
import { useEffect, useState } from "react";
import type { RecruitModelPolicy } from "../experts/types";
import { usePlatformModelsApi } from "./usePlatformModelsApi";

export interface ModelChoice {
  /** 下拉里的稳定键：provider 与 model 组合，避免不同 provider 的同名模型冲突。 */
  key: string;
  provider_id: string;
  model_id: string;
  label: string;
}

export type { RecruitModelPolicy };

export function toPolicy(choice: ModelChoice): RecruitModelPolicy {
  return { provider_ref: choice.provider_id, model: choice.model_id };
}

export function choiceKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export interface RecruitModels {
  choices: ModelChoice[];
  loading: boolean;
  error: string | null;
}

export function useRecruitModels(): RecruitModels {
  const api = usePlatformModelsApi();
  const [state, setState] = useState<RecruitModels>({ choices: [], loading: true, error: null });

  useEffect(() => {
    let active = true;
    api.list().then(
      (catalog) => {
        if (!active) return;
        const choices = catalog.models
          .filter(isSelectablePlatformModel)
          .map<ModelChoice>((item) => {
            const { provider_id, model_id, display_name } = item.model;
            const name = display_name && display_name !== model_id ? `${display_name} · ${model_id}` : model_id;
            return { key: choiceKey(provider_id, model_id), provider_id, model_id, label: name };
          });
        setState({ choices, loading: false, error: null });
      },
      (err) => {
        if (active) setState({ choices: [], loading: false, error: err instanceof Error ? err.message : "模型列表加载失败" });
      },
    );
    return () => { active = false; };
  }, [api]);

  return state;
}
