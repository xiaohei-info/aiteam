import { useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/CodeBlock";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { VStack } from "@astryxdesign/core/VStack";
import { useI18n } from "../../i18n/context";

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Continue with the HTTP-compatible fallback.
    }
  }
  try {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.setAttribute("readonly", "");
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textArea);
    return copied;
  } catch {
    return false;
  }
}

interface Props {
  secret: string;
  enterpriseId: string;
  tenantId: string;
  ownerPhone: string;
  enterpriseCode?: string | null;
  mustReset: boolean;
  onDismiss: () => void;
}

function masked(secret: string): string {
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}

export function BootstrapSecretDisplay({
  secret,
  enterpriseId,
  tenantId,
  ownerPhone,
  enterpriseCode,
  mustReset,
  onDismiss,
}: Props): ReactNode {
  const i18n = useI18n();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const title = i18n.t("operation.enterprise.bootstrap_secret");

  async function handleCopy(): Promise<void> {
    const succeeded = await copyText(secret);
    if (!succeeded) {
      setCopyFailed(true);
      return;
    }
    setCopyFailed(false);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card role="region" aria-label={title} data-testid="secret-display">
      <VStack gap={4}>
        <HStack justify="between" align="center">
          <Heading level={2}>{title}</Heading>
          <Button label="关闭凭据" variant="ghost" size="sm" onClick={onDismiss} />
        </HStack>
        <Banner status="warning" title={i18n.t("operation.enterprise.secret_warning")} />
        <Code>{copyFailed ? secret : masked(secret)}</Code>
        <MetadataList columns="single">
          <MetadataListItem label={i18n.t("operation.enterprise.result_enterprise_id")}><Code>{enterpriseId}</Code></MetadataListItem>
          <MetadataListItem label={i18n.t("operation.enterprise.result_tenant_id")}><Code>{tenantId}</Code></MetadataListItem>
          <MetadataListItem label={i18n.t("operation.enterprise.result_owner_phone")}><Code>{ownerPhone}</Code></MetadataListItem>
          {enterpriseCode && (
            <MetadataListItem label={i18n.t("operation.enterprise.result_enterprise_code")}><Code>{enterpriseCode}</Code></MetadataListItem>
          )}
          <MetadataListItem label={i18n.t("operation.enterprise.result_must_reset")}>
            {mustReset ? i18n.t("operation.enterprise.result_must_reset_yes") : i18n.t("operation.enterprise.result_must_reset_no")}
          </MetadataListItem>
        </MetadataList>
        {copyFailed && <Banner status="warning" title={i18n.t("operation.enterprise.copy_failed")} />}
        <HStack justify="end">
          <Button
            label={copied ? i18n.t("operation.enterprise.copied") : i18n.t("operation.enterprise.copy")}
            variant="secondary"
            onClick={() => void handleCopy()}
          />
        </HStack>
      </VStack>
    </Card>
  );
}
