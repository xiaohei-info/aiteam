/**
 * 企业端技能的「编辑 / 从零写一个」与「导入技能」（设计 2026-11-20 §4.7）。
 *
 * 编辑的是技能本身（SKILL.md 的名称、说明、指令 + 附带文件），用共享的 SkillEditorDialog；
 * 企业自己的设置只有两项真正生效的：
 * - 「成员可以自己安装」：visibility tenant ↔ private（private 时只能由管理员配给专家）；
 * - 「停用」：binding_policy disabled（成员不能再安装；专家下次同步后跳过；成员自装的不收回）。
 * 从平台技能市场装的技能（设计「技能MCP命名空间出处与更新提示」§4.2）：改了内容就另存为企业自己的副本
 * （企业名/名称，「改自 taiyim/…」），平台原件保留并继续跟随平台更新；只改两项设置则作用于原件。
 */
import { useState, type ReactNode } from "react";
import {
  ApiError,
  capabilityTitle,
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

/** 技能是否从平台技能市场安装（内容由运营端维护；编辑另存为企业副本）。 */
export function isPlatformSkill(row: SkillCatalog): boolean {
  return row.config?.source === "operator";
}

/** SKILL.md 的 name：企业技能就是 skill_id；平台技能存在 config.skill_name（旧条目退回显示名）。 */
export function skillName(row: SkillCatalog): string {
  if (!isPlatformSkill(row)) return row.skill_id;
  return String(row.config?.skill_name || row.config?.slug || row.display_name || row.skill_id);
}

/** 列表与标题里的完整名称：taiyim/weather、太一科技/周报；原样取自其他平台的不带前缀。 */
export function skillTitle(row: SkillCatalog): string {
  return capabilityTitle(row.namespace, row.display_name || skillName(row));
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
        <CheckboxInput label="停用" description="停用后成员不能再安装；已配给专家的，下次同步后专家不再使用它（专家其他能力照常）；成员已自行安装的不受影响。" value={Boolean(disabled)} onChange={onDisabled} />
      )}
    </VStack>
  );
}

export function EnterpriseSkillEditor({ api, row, existingIds, enterpriseNamespace, onSaved, onClose }: {
  api: CapabilityApi;
  /** 编辑已有技能；不传为「从零写一个」。 */
  row?: SkillCatalog;
  /** 目录里已有的技能 skill_id：新建时不能重名（重名会变成升级那个技能）。 */
  existingIds: Set<string>;
  /** 企业名称（未设置时企业代码），用于说明副本的名字；取不到时只说「本企业」。 */
  enterpriseNamespace?: string;
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
      if (platform && contentChanged) {
        // 另存为企业副本：带上这里选的两项设置；平台原件不动。
        const name = parseSkillMd(files[0]!.content).name.trim();
        if (existingIds.has(name)) return `企业技能里已有「${name}」，请换个名称，或在列表里编辑它`;
        const failed = firstFailure(await api.importSkills({ ...editorInput(files), visibility, binding_policy: bindingPolicy, fork_of: row.catalog_id }));
        if (failed) return failed;
        onSaved(`已另存为企业技能 ${capabilityTitle(enterpriseNamespace, name)}，平台原件保留`);
        return null;
      }
      const settingsChanged = (row.visibility !== "private") !== memberInstall || (row.binding_policy === "disabled") !== disabled;
      // 先改设置（用当前版本），再存内容（升新版本时保留刚改的设置）。
      if (settingsChanged) await api.updateSkillSettings(row.catalog_id, { skill_id: row.skill_id, visibility, binding_policy: bindingPolicy });
      if (contentChanged) {
        const failed = firstFailure(await api.importSkills(editorInput(files)));
        if (failed) return failed;
      }
      onSaved(contentChanged ? `已保存 ${skillTitle(row)}（新版本）` : settingsChanged ? `已更新 ${skillTitle(row)} 的设置` : "没有改动");
      return null;
    } catch (err) {
      return err instanceof ApiError || err instanceof Error ? err.message : "保存失败，请重试";
    }
  }

  return (
    <SkillEditorDialog
      title={row ? `编辑技能 ${skillTitle(row)}` : "从零写一个技能"}
      files={row?.files}
      isNameLocked={Boolean(row) && !platform}
      note={platform ? `这是平台技能。改了内容保存后会生成${enterpriseNamespace ? `「${enterpriseNamespace}/名称」这个` : "本企业自己的"}副本，平台原件保留并继续跟随平台更新；只改下面的设置则作用于平台原件。` : undefined}
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
