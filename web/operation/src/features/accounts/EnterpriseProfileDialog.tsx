/** 编辑企业行业 / 标签：专家发布范围按它们匹配企业。 */
import { useEffect, useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { parseTags } from "../enterprise/ProvisionForm";
import type { EnterpriseAccount } from "./types";
import type { AccountsApi } from "./useAccountsApi";

interface Props {
  api: AccountsApi;
  enterprise: EnterpriseAccount;
  onClose: () => void;
  onDone: () => void;
}

export function EnterpriseProfileDialog({ api, enterprise, onClose, onDone }: Props): ReactNode {
  const [industry, setIndustry] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!api.getProfile) {
      setError("企业资料接口不可用");
      setLoading(false);
      return () => { active = false; };
    }
    api.getProfile(enterprise.org_id).then((profile) => {
      if (!active || !profile) return;
      setIndustry(profile.industry ?? "");
      setTagsText(profile.tags.join(", "));
    }).catch((err) => {
      if (active) setError(err instanceof Error && err.message ? err.message : "加载失败");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, enterprise.org_id]);

  async function submit(): Promise<void> {
    const tags = parseTags(tagsText);
    if (industry.trim().length > 20 || tags.length > 10 || tags.some((tag) => tag.length > 20)) {
      setError("行业不超过 20 字；标签最多 10 个，每个不超过 20 字");
      return;
    }
    if (!api.setProfile) return;
    setBusy(true);
    setError(null);
    try {
      await api.setProfile(enterprise.org_id, { industry: industry.trim() || null, tags });
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "保存失败");
      setBusy(false);
    }
  }

  const close = () => { if (!busy) onClose(); };

  return (
    <Dialog isOpen onOpenChange={(open) => { if (!open) close(); }} purpose="form" width={480} aria-label={`编辑 ${enterprise.enterprise_name} 企业信息`}>
      <Layout
        header={<DialogHeader title="编辑企业信息" onOpenChange={(open) => { if (!open) close(); }} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              <TextInput label="所属行业" value={industry} onChange={setIndustry} placeholder="如：制造业" isOptional isDisabled={loading || busy} />
              <TextInput label="企业标签" value={tagsText} onChange={setTagsText} placeholder="多个用逗号分隔，如：华东, KA" isOptional isDisabled={loading || busy} />
              {error && <Banner status="error" title={error} />}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} hAlign="end">
              <Button label="取消" variant="ghost" onClick={close} isDisabled={busy} />
              <Button label="保存" variant="primary" onClick={() => void submit()} isLoading={busy} isDisabled={loading} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
