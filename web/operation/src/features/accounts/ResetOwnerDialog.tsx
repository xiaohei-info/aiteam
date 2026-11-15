/** 重置企业管理员（负责人）密码：确认 → 一次性展示新凭据。关闭后凭据不可再看。 */
import { useRef, useState, type ReactNode } from "react";
import { newIdempotencyKey } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { BootstrapSecretDisplay } from "../enterprise/BootstrapSecretDisplay";
import type { EnterpriseAccount, OwnerResetResult } from "./types";
import type { AccountsApi } from "./useAccountsApi";

interface Props {
  api: AccountsApi;
  enterprise: EnterpriseAccount;
  onClose: () => void;
}

export function ResetOwnerDialog({ api, enterprise, onClose }: Props): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OwnerResetResult | null>(null);
  // 同一次对话框内的重试沿用同一个幂等键：网络失败后再点不会重复重置。
  const key = useRef(`owner-bootstrap-reset:${newIdempotencyKey()}`);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.resetOwnerBootstrap(enterprise.org_id, key.current));
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "重置失败");
    } finally {
      setBusy(false);
    }
  }

  const close = () => { if (!busy) onClose(); };

  return (
    <Dialog isOpen onOpenChange={(open) => { if (!open) close(); }} purpose="form" width={520} aria-label={`重置 ${enterprise.enterprise_name} 管理员密码`}>
      <Layout
        header={<DialogHeader title="重置管理员密码" onOpenChange={(open) => { if (!open) close(); }} />}
        content={
          <LayoutContent>
            {result ? (
              <VStack gap={3}>
                <Banner status="success" title="管理员密码已重置" />
                <BootstrapSecretDisplay
                  secret={result.owner_bootstrap_secret}
                  enterpriseId={result.enterprise_id}
                  tenantId={result.tenant_id}
                  ownerPhone={result.owner_phone}
                  mustReset={result.must_reset}
                  onDismiss={onClose}
                />
              </VStack>
            ) : (
              <VStack gap={3}>
                <Text>
                  将为「{enterprise.enterprise_name}」的管理员生成新的一次性密码，旧密码立即失效。
                </Text>
                <Text color="secondary">
                  通行密钥等二次验证会被清除，第三方登录会被解绑；该管理员在网页和桌面端都需要重新登录。其他成员不受影响。
                </Text>
                {error && <Banner status="error" title={error} />}
              </VStack>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} hAlign="end">
              {result ? (
                <Button label="完成" onClick={onClose} />
              ) : (
                <>
                  <Button label="取消" variant="ghost" onClick={close} isDisabled={busy} />
                  <Button label="确认重置" variant="destructive" onClick={() => void submit()} isLoading={busy} />
                </>
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
