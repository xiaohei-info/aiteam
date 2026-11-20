/**
 * 运营端自建技能（设计 2026-11-20 §4.7）：不在 ClawHub 上的技能，由运营端上传、粘贴、给网址或在线写。
 * 与企业端同一套技能编辑器与导入对话框（@aiteam/shared）；保存后成为平台技能的新版本，
 * 是否开放给企业跟随「下载后自动开放」开关。编辑 ClawHub 导入的技能会另存为平台副本（taiyim/名称，标「改自 ClawHub …」），
 * ClawHub 原件保留（设计「技能MCP命名空间出处与更新提示」§4.2）。
 */
import type { ReactNode } from "react";
import {
  capabilityTitle,
  editorInput,
  parseSkillMd,
  SkillEditorDialog,
  SkillImportDialog,
  type SkillEditorSaveInput,
  type SkillFile,
  type SkillImportResponse,
} from "@aiteam/shared";
import { errorText } from "./useExternalSkills";
import type { useSkillMarketApi } from "./useSkillMarketApi";
import type { InternalSkill } from "./types";

type SkillMarketApi = ReturnType<typeof useSkillMarketApi>;

function outcome(response: SkillImportResponse | null): { failed: string | null; version: string; published: boolean } {
  const result = response?.results?.[0];
  if (!result) return { failed: "保存失败，请重试", version: "", published: false };
  return { failed: result.status === "failed" ? result.reason || "保存失败" : null, version: result.version, published: Boolean(response?.auto_publish) };
}

export function PlatformSkillEditor({ api, skill, files, customNames, onSaved, onClose }: {
  api: SkillMarketApi;
  /** 编辑或查看已有平台技能；不传为「从零写一个」。 */
  skill?: InternalSkill;
  files?: SkillFile[];
  /** 已有自建技能的名称：新建时不能重名（重名会变成那个技能的新版本）。 */
  customNames: Set<string>;
  onSaved: (message: string) => void;
  onClose: () => void;
}): ReactNode {
  // 编辑 ClawHub 技能 = 另存为平台副本；原件不动。
  const fork = Boolean(skill && skill.source !== "custom");

  async function save({ files: next, contentChanged }: SkillEditorSaveInput): Promise<string | null> {
    const name = parseSkillMd(next[0]!.content).name.trim();
    if ((!skill || fork) && customNames.has(name)) return `平台里已有自建技能「${capabilityTitle("taiyim", name)}」，请换个名称，或在列表里编辑它`;
    if (fork && !contentChanged) return "还没有改动。改了内容再保存成平台副本；不改的话直接用 ClawHub 原件即可";
    if (skill && !contentChanged) { onSaved("没有改动"); return null; }
    try {
      const { failed, version, published } = outcome(await api.saveCustom(editorInput(next), fork ? skill!.skill_id : undefined));
      if (failed) return failed;
      onSaved(`已保存 ${capabilityTitle("taiyim", name)} v${version}（${published ? "已开放给企业" : "待开放"}）${fork ? "；ClawHub 原件保留" : ""}`);
      return null;
    } catch (err) {
      return errorText(err, "保存失败，请重试");
    }
  }

  return (
    <SkillEditorDialog
      title={skill ? `编辑技能 ${capabilityTitle(skill.namespace, skill.display_name || skill.slug)}` : "从零写一个技能"}
      files={files}
      isNameLocked={Boolean(skill) && !fork}
      note={fork ? `这个技能来自 ClawHub ${skill!.owner}/${skill!.slug}。保存后生成平台副本（taiyim/名称，标「改自 ClawHub」），ClawHub 原件保留；副本不再跟随 ClawHub 更新。` : undefined}
      onSave={save}
      onClose={onClose}
    />
  );
}

export function CustomSkillImport({ api, onImported, onClose }: {
  api: SkillMarketApi;
  onImported: () => void;
  onClose: () => void;
}): ReactNode {
  return (
    <SkillImportDialog
      api={{ preview: (input) => api.previewCustom(input), save: (input) => api.saveCustom(input) }}
      sources={["folder", "zip", "file", "text", "url"]}
      updateNote="与已有自建技能同名、内容不同的，会成为它的新版本，企业端显示「可更新」。"
      onImported={onImported}
      onClose={onClose}
    />
  );
}
