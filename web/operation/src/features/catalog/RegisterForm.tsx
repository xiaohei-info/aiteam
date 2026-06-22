/**
 * 注册模板/方案表单（F03）。
 * 对齐后端：
 *   POST /catalog/expert-templates → {template_id, display_name, persona?}
 *   POST /catalog/solution-templates → {solution_id, display_name}
 */
import { type FormEvent, useState, type ReactNode } from "react";
import { Button, Field, GlassPanel, Input, Select } from "@aiteam/shared/ui";
import { useI18n } from "../../i18n/context";
import type { CatalogApi } from "./useCatalogApi";
import type { CatalogItemType } from "./types";

const textareaCls =
  "min-h-[80px] rounded-md border border-gold/20 bg-surface px-md py-sm text-sm " +
  "text-text-primary outline-none transition placeholder:text-text-muted " +
  "focus:border-gold/50 focus:ring-2 focus:ring-gold";

interface Props {
  api: CatalogApi;
  onDone: () => void;
  onCancel: () => void;
}

export function RegisterForm({ api, onDone, onCancel }: Props): ReactNode {
  const i18n = useI18n();
  const [type, setType] = useState<CatalogItemType>("expert_template");
  const [id, setId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [persona, setPersona] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setValidationError(null);
    if (!displayName.trim()) {
      setValidationError("名称不能为空");
      return;
    }
    if (!id.trim()) {
      setValidationError("模板 ID 不能为空");
      return;
    }
    setLoading(true);
    try {
      if (type === "expert_template") {
        await api.registerExpert({
          template_id: id.trim(),
          display_name: displayName.trim(),
          ...(persona.trim() ? { persona: persona.trim() } : {}),
        });
      } else {
        await api.registerSolution({
          solution_id: id.trim(),
          display_name: displayName.trim(),
        });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "注册失败");
    } finally {
      setLoading(false);
    }
  }

  const displayError = validationError ?? error;

  return (
    <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
      <h2 className="m-0 text-base font-semibold text-text-primary">注册新模板/方案</h2>
      <form className="flex flex-col gap-md" onSubmit={handleSubmit}>
        <Field label="类型">
          <Select value={type} onChange={(e) => setType(e.target.value as CatalogItemType)}>
            <option value="expert_template">{i18n.t("operation.catalog.expertTemplate")}</option>
            <option value="solution_template">{i18n.t("operation.catalog.solutionTemplate")}</option>
          </Select>
        </Field>
        <Field label="模板 ID">
          <Input
            type="text"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder={type === "expert_template" ? "template_id" : "solution_id"}
            disabled={loading}
          />
        </Field>
        <Field label="名称">
          <Input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="display_name"
            disabled={loading}
          />
        </Field>
        {type === "expert_template" && (
          <Field label="Persona（可选）">
            <textarea
              className={textareaCls}
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              placeholder="专家人设描述（可选）"
              disabled={loading}
            />
          </Field>
        )}
        {displayError && <p className="m-0 text-sm text-danger">{displayError}</p>}
        <div className="flex gap-sm">
          <Button type="submit" disabled={loading} className="self-start">
            {loading ? "提交中…" : "注册"}
          </Button>
          <Button type="button" variant="ghost" disabled={loading} onClick={onCancel}>
            取消
          </Button>
        </div>
      </form>
    </GlassPanel>
  );
}
