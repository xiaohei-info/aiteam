/** 草稿列表每行的「操作」菜单：继续生成、取消生成、删除。可用项与后端规则一致，不可用的不显示。 */
import type { ReactNode } from "react";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import type { DraftSummary } from "./types";

export type RowAction = "continue" | "cancel" | "delete";

/** 已审核通过 / 已发布的草稿只有管理员能删除（后端同样校验）。 */
export function availableActions(draft: DraftSummary, isAdmin: boolean): RowAction[] {
  const actions: RowAction[] = [];
  // 「继续生成」：还没有正文的草稿（从未生成，或生成失败 / 被取消）。已有正文的在详情页「重新生成」。
  if (draft.status === "draft") actions.push("continue");
  if (draft.status === "generating") actions.push("cancel");
  const reviewed = draft.status === "approved" || draft.status === "published";
  if (draft.status !== "archived" && (isAdmin || !reviewed)) actions.push("delete");
  return actions;
}

interface Props {
  draft: DraftSummary;
  isAdmin: boolean;
  isDisabled?: boolean;
  onAction: (action: RowAction, draft: DraftSummary) => void;
}

export function DraftRowActions({ draft, isAdmin, isDisabled, onAction }: Props): ReactNode {
  const actions = availableActions(draft, isAdmin);
  if (actions.length === 0) return null;
  return (
    <DropdownMenu
      button={{ label: "操作", size: "sm", variant: "ghost", isDisabled }}
      data-testid={`draft-actions-${draft.draft_id}`}
      menuWidth={160}
    >
      {actions.includes("continue") && <DropdownMenuItem label="继续生成" onClick={() => onAction("continue", draft)} />}
      {actions.includes("cancel") && <DropdownMenuItem label="取消生成" onClick={() => onAction("cancel", draft)} />}
      {actions.includes("delete") && <DropdownMenuItem label="删除" onClick={() => onAction("delete", draft)} />}
    </DropdownMenu>
  );
}
