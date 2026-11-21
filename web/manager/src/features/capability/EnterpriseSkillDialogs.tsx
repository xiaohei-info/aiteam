/**
 * 企业端技能的「编辑 / 从零写一个」与「导入技能」（设计 2026-11-20 §4.7）。
 *
 * 编辑的是技能本身（SKILL.md 的名称、说明、指令 + 附带文件），用共享的 SkillEditorDialog；
 * 企业自己的设置只有两项真正生效的：
 * - 「成员可以自己安装」：visibility tenant ↔ private（private 时只能由管理员配给专家）；
 * - 「停用」：binding_policy disabled（专家和成员都不能用）。
 * 从平台技能市场装的技能内容由运营端维护，这里只能查看，两项设置照常可改。
 */
import { useState, type ReactNode } from "react";
import {
  ApiError,
  editorInput,
  parseSkillMd,
  SkillEditorDialog,
  SkillImportDialog,
  type SkillEditorSaveInput,
  type SkillImportResponse,
} from "@aiteam/shared";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { VStack } from "@astryxdesign/core/VStack";
import type { CapabilityApi } from "./useCapabilityApi";
import type { CatalogVisibility, SkillBindingPolicy, SkillCatalog } from "./types";

const MEMBER_INSTALL_HINT = "不勾选时成员看不到它，只能由管理员配给专家。";

/** 技能是否从平台技能市场安装（内容只读）。 */
export function isPlatformSkill(row: SkillCatalog): boolean {
  return row.config?.source === "operator";
}

function firstFailure(response: SkillImportResponse | null): string | null {
  const result = response?.results?.[0];
  if (!result) return "保存失败，请重试";
  return result.status === "failed" ? result.reason || "保存失败" : null;
}

function SkillSettings({ memberInstall, disabled, onMemberInstall, onDisabled }: {
  memberInstall: boolean;
  disabled?: boolean;
  onMemberInstall: (value: boolean) => void;
  onDisabled?: (value: boolean) => void;
}): ReactNode {
  return (
    <VStack gap={2}>
      <CheckboxInput label="成员可以自己安装" description={MEMBER_INSTALL_HINT} value={memberInstall} onChange={onMemberInstall} />
      {onDisabled && (
        <CheckboxInput label="停用" description="停用后专家和成员都不能用这个技能，已配置的也会失效。" value={Boolean(disabled)} onChange={onDisabled} />
      )}
    </VStack>
  );
}

export function EnterpriseSkillEditor({ api, row, existingIds, onSaved, onClose }: {
  api: CapabilityApi;
  /** 编辑已有技能；不传为「从零写一个」。 */
  row?: SkillCatalog;
  /** 目录里已有的技能 skill_id：新建时不能重名（重名会变成升级那个技能）。 */
  existingIds: Set<string>;
  onSaved: (message: string) => void;
  onClose: () => void;
}): ReactNode {
  const [memberInstall, setMemberInstall] = useState(row ? row.visibility !== "private" : true);
  const [disabled, setDisabled] = useState(row?.binding_policy === "disabled");
  const platform = row ? isPlatformSkill(row) : false;
  // 只改界面上的两个开关；旧表单留下的 public / auto_bind 等值在没动对应开关时原样保留，不被悄悄改掉。
  const visibility: CatalogVisibility = memberInstall ? (row && row.visibility !== "private" ? row.visibility as CatalogVisibility : "tenant") : "private";
  const bindingPolicy: SkillBindingPolicy = disabled ? "disabled" : (row && row.binding_policy !== "disabled" ? row.binding_policy as SkillBindingPolicy : "opt_in");

  async function save({ files, contentChanged }: SkillEditorSaveInput): Promise<string | null> {
    try {
      if (!row) {
        const name = parseSkillMd(files[0]!.content).name.trim();
        if (existingIds.has(name)) return `企业技能里已有「${name}」，请换个名称，或在列表里编辑它`;
        const failed = firstFailure(await api.importSkills({ ...editorInput(files), visibility, binding_policy: bindingPolicy }));
        if (failed) return failed;
        onSaved(`已新建技能 ${name}`);
        return null;
      }
      const settingsChanged = (row.visibility !== "private") !== memberInstall || (row.binding_policy === "disabled") !== disabled;
      // 先改设置（用当前版本），再存内容（升新版本时保留刚改的设置）。
      if (settingsChanged) await api.updateSkillSettings(row.catalog_id, { skill_id: row.skill_id, visibility, binding_policy: bindingPolicy });
      if (contentChanged && !platform) {
        const failed = firstFailure(await api.importSkills(editorInput(files)));
        if (failed) return failed;
      }
      onSaved(contentChanged && !platform ? `已保存 ${row.display_name}（新版本）` : settingsChanged ? `已更新 ${row.display_name} 的设置` : "没有改动");
      return null;
    } catch (err) {
      return err instanceof ApiError || err instanceof Error ? err.message : "保存失败，请重试";
    }
  }

  return (
    <SkillEditorDialog
      title={row ? (platform ? `查看技能 ${row.display_name}` : `编辑技能 ${row.display_name}`) : "从零写一个技能"}
      files={row?.files}
      isNameLocked={Boolean(row)}
      readOnlyReason={platform ? "这个技能从平台技能市场安装，内容由运营端维护，这里只能查看；下面的设置可以改。" : undefined}
      extraNameProblem={(name) => (name.startsWith("platform-") ? "platform- 开头的名称留给平台技能市场" : null)}
      settings={<SkillSettings memberInstall={memberInstall} disabled={disabled} onMemberInstall={setMemberInstall} onDisabled={setDisabled} />}
      onSave={save}
      onClose={onClose}
    />
  );
}

export function EnterpriseSkillImport({ api, initial, onImported, onClose }: {
  api: CapabilityApi;
  initial?: { source: "url" | "clawhub"; url: string };
  onImported: () => void;
  onClose: () => void;
}): ReactNode {
  const [memberInstall, setMemberInstall] = useState(true);
  return (
    <SkillImportDialog
      api={{
        preview: (input) => api.previewSkillImport(input),
        save: (input) => api.importSkills({ ...input, visibility: memberInstall ? "tenant" : "private" }),
      }}
      initial={initial}
      settings={<SkillSettings memberInstall={memberInstall} onMemberInstall={setMemberInstall} />}
      updateNote="升级已有技能时保留它原来的设置。"
      onImported={onImported}
      onClose={onClose}
    />
  );
}
