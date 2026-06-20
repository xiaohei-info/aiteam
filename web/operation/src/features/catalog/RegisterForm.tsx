/**
 * 注册表单（F03）：专家模板 / 行业方案。
 *
 * POST /api/operation/catalog/register-expert-template
 * POST /api/operation/catalog/register-solution-template
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { useCatalogApi } from "./useCatalogApi";

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
    <form className="catalog-register-form" onSubmit={handleSubmit}>
      <h2>注册新模板/方案</h2>

      <label>
        类型：
        <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="expert_template">专家模板</option>
          <option value="solution_template">行业方案</option>
        </select>
      </label>

      <label>
        名称：
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>

      <label>
        描述：
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <label>
        标签（逗号分隔）：
        <input
          type="text"
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="如：客服, 金融, 零售"
        />
      </label>

      {error && (
        <div className="catalog-register-form__error" role="alert">
          {error}
        </div>
      )}

      <div className="catalog-register-form__buttons">
        <button type="submit" disabled={submitting}>
          {submitting ? "提交中…" : "注册"}
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}
