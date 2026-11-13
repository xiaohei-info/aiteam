/** R5 企业删除相关弹窗：删除（输入企业名称确认）/ 恢复 / 保留期满后清理。仅 system_admin 可见入口。 */
import { useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import type { EnterpriseAccount } from "./types";
import type { AccountsApi } from "./useAccountsApi";

export type DeletionMode = "delete" | "restore" | "purge";

const COPY: Record<DeletionMode, { title: string; confirm: string; body: (name: string) => string }> = {
  delete: {
    title: "删除企业",
    confirm: "确认删除",
    body: (name) => `删除后「${name}」的所有成员将无法登录和同步，30 天内可恢复；30 天后数据将被清理，且无法找回。`,
  },
  restore: {
    title: "恢复企业",
    confirm: "确认恢复",
    body: (name) => `将「${name}」恢复为已注销状态。恢复后仍需另行处理才能重新启用。`,
  },
  purge: {
    title: "清理企业数据",
    confirm: "确认清理",
    body: (name) => `将永久清理「${name}」在企业端的全部业务数据，并匿名化企业名称和负责人手机号。充值、计量与审计记录保留。此操作不可撤销。`,
  },
};

interface Props {
  mode: DeletionMode;
  api: AccountsApi;
  enterprise: EnterpriseAccount;
  onClose: () => void;
  onDone: () => void;
}

export function DeletionDialog({ mode, api, enterprise, onClose, onDone }: Props): ReactNode {
  const copy = COPY[mode];
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsName = mode === "delete";
  const matches = !needsName || typed.trim() === enterprise.enterprise_name;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (mode === "delete") await api.deleteEnterprise(enterprise.org_id, typed.trim());
      else if (mode === "restore") await api.restoreEnterprise(enterprise.org_id);
      else await api.purgeEnterprise(enterprise.org_id);
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "操作失败，请稍后重试");
      setBusy(false);
    }
  }

  const close = () => { if (!busy) onClose(); };

  return (
    <Dialog isOpen onOpenChange={(open) => { if (!open) close(); }} purpose="form" width={480} aria-label={copy.title}>
      <Layout
        header={<DialogHeader title={copy.title} onOpenChange={(open) => { if (!open) close(); }} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              <Text>{copy.body(enterprise.enterprise_name)}</Text>
              {needsName && (
                <TextInput
                  label={`请输入企业名称「${enterprise.enterprise_name}」以确认`}
                  value={typed}
                  onChange={setTyped}
                  isDisabled={busy}
                />
              )}
              {error && <Banner status="error" title={error} />}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} hAlign="end">
              <Button label="取消" variant="ghost" onClick={close} isDisabled={busy} />
              <Button
                label={copy.confirm}
                variant={mode === "restore" ? "primary" : "destructive"}
                onClick={() => void submit()}
                isLoading={busy}
                isDisabled={!matches}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
