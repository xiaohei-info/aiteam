/**
 * 注册表单（F03）：专家模板 / 行业方案。
 *
 * POST /api/operation/catalog/register-expert-template
 * POST /api/operation/catalog/register-solution-template
 * 黑金玻璃质感，复用 shared 组件（GlassPanel/Button/Field/Input/Select）。
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Button, Field, GlassPanel, Input, Select } from "@aiteam/shared/ui";
import { useCatalogApi } from "./useCatalogApi";

const textareaCls =
  "min-h-[80px] rounded-md border border-gold/20 bg-surface px-md py-sm text-sm text-text-primary " +
  "outline-none transition placeholder:text-text-muted focus:border-gold/50 focus:ring-2 focus:ring-gold";

interface Props {
  onSuccess: () => void;
  onCancel: () => void;
}

export function RegisterForm({ onSuccess, onCancel }: Props): ReactNode {
  const api = useCatalogApi();
  const [type, setType] = useState<"expert_template" | "solution_template">(
    "expert_template",
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("名称不能为空");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const tags = tagsText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (type === "expert_template") {
        await api.registerExpert({ name: name.trim(), description, tags });
      } else {
        await api.registerSolution({ name: name.trim(), description, tags });
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "注册失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
        <h2 className="m-0 text-base font-semibold text-text-primary">注册新模板/方案</h2>

        <Field label="类型：">
          <Select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="expert_template">专家模板</option>
            <option value="solution_template">行业方案</option>
          </Select>
        </Field>

        <Field label="名称：">
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>

        <Field label="描述：">
          <textarea
            className={textareaCls}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <Field label="标签（逗号分隔）：">
          <Input
            type="text"
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="如：客服, 金融, 零售"
          />
        </Field>

        {error && (
          <p className="m-0 text-sm text-danger" role="alert">
            {error}
          </p>
        )}

        <div className="flex gap-sm">
          <Button type="submit" size="sm" disabled={submitting}>
            {submitting ? "提交中…" : "注册"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
        </div>
      </GlassPanel>
    </form>
  );
}