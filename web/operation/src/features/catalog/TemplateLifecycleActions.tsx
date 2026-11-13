import { useRef, useState, type ReactNode } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { ScopeDialog } from "./ScopeDialog";
import type { CatalogItem, VisibleScope } from "./types";

/** publish / scope 带发布范围；unpublish 无参数。 */
export type TemplateLifecycleAction = "publish" | "unpublish" | "scope";
export type LifecycleHandler = (action: TemplateLifecycleAction, scope?: VisibleScope) => Promise<void>;

interface TemplateLifecycleActionsProps {
  item: CatalogItem;
  onAction: LifecycleHandler;
}

const ACTION_LABELS: Record<TemplateLifecycleAction, string> = {
  publish: "发布",
  unpublish: "下架",
  scope: "发布范围",
};

function availableActions(status: CatalogItem["status"]): TemplateLifecycleAction[] {
  if (status === "published") return ["scope", "unpublish"];
  return ["publish"];
}

export function TemplateLifecycleActions({ item, onAction }: TemplateLifecycleActionsProps): ReactNode {
  const [action, setAction] = useState<TemplateLifecycleAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const keepOpenOnAction = useRef(false);

  async function confirmUnpublish() {
    keepOpenOnAction.current = true;
    setWorking(true);
    setError(null);
    try {
      await onAction("unpublish");
      keepOpenOnAction.current = false;
      setAction(null);
    } catch (err) {
      keepOpenOnAction.current = false;
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <HStack gap={1} wrap="wrap">
        {availableActions(item.status).map((nextAction) => (
          <Button
            key={nextAction}
            label={ACTION_LABELS[nextAction]}
            variant="ghost"
            size="sm"
            onClick={() => {
              keepOpenOnAction.current = false;
              setError(null);
              setAction(nextAction);
            }}
          />
        ))}
      </HStack>

      {(action === "publish" || action === "scope") && (
        <ScopeDialog
          title={action === "publish" ? "发布模板" : "调整发布范围"}
          confirmLabel={action === "publish" ? "确认发布" : "保存范围"}
          initial={action === "scope" ? item.visible_scope : undefined}
          onConfirm={async (scope) => { await onAction(action, scope); setAction(null); }}
          onClose={() => setAction(null)}
        />
      )}

      <AlertDialog
        isOpen={action === "unpublish"}
        onOpenChange={(open) => {
          if (!open && !working && !keepOpenOnAction.current) {
            setAction(null);
            setError(null);
          }
        }}
        title="下架模板"
        description={`确认要下架模板「${item.display_name}」吗？已招募的专家不受影响。${error ? ` ${error}` : ""}`}
        cancelLabel="取消"
        actionLabel="确认下架"
        actionVariant="destructive"
        isActionLoading={working}
        onAction={() => void confirmUnpublish()}
      />
    </>
  );
}
