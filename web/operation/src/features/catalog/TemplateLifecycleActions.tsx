import { useRef, useState, type ReactNode } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import type { CatalogItem } from "./types";

export type TemplateLifecycleAction = "publish" | "unpublish" | "hide";

interface TemplateLifecycleActionsProps {
  item: CatalogItem;
  onAction: (action: TemplateLifecycleAction) => Promise<void>;
}

const ACTION_LABELS: Record<TemplateLifecycleAction, string> = {
  publish: "发布",
  unpublish: "下架",
  hide: "隐藏",
};

function availableActions(status: CatalogItem["status"]): TemplateLifecycleAction[] {
  if (status === "published") return ["unpublish", "hide"];
  return ["publish", "hide"];
}

export function TemplateLifecycleActions({ item, onAction }: TemplateLifecycleActionsProps): ReactNode {
  const [action, setAction] = useState<TemplateLifecycleAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const keepOpenOnAction = useRef(false);

  const label = action ? ACTION_LABELS[action] : "";

  async function confirm() {
    if (!action) return;
    keepOpenOnAction.current = true;
    setWorking(true);
    setError(null);
    try {
      await onAction(action);
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
            variant={nextAction === "hide" ? "destructive" : "ghost"}
            size="sm"
          onClick={() => {
              keepOpenOnAction.current = false;
              setError(null);
              setAction(nextAction);
            }}
          />
        ))}
      </HStack>

      <AlertDialog
        isOpen={action !== null}
        onOpenChange={(open) => {
          if (!open && !working && !keepOpenOnAction.current) {
            setAction(null);
            setError(null);
          }
        }}
        title={`${label}模板`}
        description={action === "hide"
          ? `隐藏后模板不再向企业展示。${error ? ` ${error}` : ""}`
          : `确认要${label}模板「${item.display_name}」吗？${error ? ` ${error}` : ""}`}
        cancelLabel="取消"
        actionLabel={`确认${label}`}
        actionVariant={action === "publish" ? "primary" : "destructive"}
        isActionLoading={working}
        onAction={() => void confirm()}
      />
    </>
  );
}
