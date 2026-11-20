/**
 * 「让模型帮我找」（设计 2026-11-20 §4.5）：管理员描述需求，企业端用所选平台模型做一次有界查找，只给候选。
 * 「用这个」把候选交给技能导入或企业 MCP 对话框，管理员在那里检查后再安装；这里不安装任何东西。
 */
import { useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { scannerBadge } from "../capability/SkillImportDialog";
import { ModelPicker } from "../platform-models/ModelPicker";
import { useRecruitModels } from "../platform-models/useRecruitModels";
import type { CapabilityAssistCandidate, CapabilityAssistResult } from "./types";
import type { CapabilityAssistApi } from "./useCapabilityAssistApi";

const SOURCE_LABEL: Record<CapabilityAssistCandidate["source"], string> = {
  clawhub: "ClawHub", github: "GitHub", url: "网址", config: "管理员给的配置",
};

interface Props {
  api: CapabilityAssistApi;
  onClose: () => void;
  /** 用户选了一个候选：调用方打开对应的导入 / 添加对话框并预填。 */
  onUse: (candidate: CapabilityAssistCandidate) => void;
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "本企业没有这个模型，请重新选择";
    if (err.status === 403) return "只有企业负责人或管理员可以使用";
    return err.message || "查找失败，请稍后再试";
  }
  return "查找失败，请稍后再试";
}

export function CapabilityAssistDialog({ api, onClose, onUse }: Props): ReactNode {
  const models = useRecruitModels();
  const [requirement, setRequirement] = useState("");
  const [link, setLink] = useState("");
  const [config, setConfig] = useState("");
  const [modelKey, setModelKey] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CapabilityAssistResult | null>(null);
  const model = models.choices.find((choice) => choice.key === modelKey);
  const ready = requirement.trim().length > 0 && model !== undefined && !busy;

  const find = async () => {
    if (!model) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.find({
        requirement: requirement.trim(),
        ...(link.trim() ? { link: link.trim() } : {}),
        ...(config.trim() ? { config_json: config.trim() } : {}),
        model: { provider_id: model.provider_id, model_id: model.model_id },
      });
      setResult(out ?? null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const close = (open: boolean) => { if (!open && !busy) onClose(); };

  const form = (
    <VStack gap={3}>
      <Text type="supporting">描述想给员工增加的能力，模型会在 ClawHub、GitHub 等处查找并核实，只给出候选、不会自动安装。用量计入企业负责人（owner）。</Text>
      <TextArea label="需求" isRequired value={requirement} onChange={setRequirement} rows={3} maxLength={2000} isDisabled={busy}
        placeholder="例如：让员工能把会议录音整理成纪要；或者：接入我们的 ERP 查询订单" />
      <TextInput label="已知链接" isOptional value={link} onChange={setLink} isDisabled={busy} placeholder="https://…（技能页、仓库或 MCP 地址）" />
      <Collapsible defaultIsOpen={false} trigger={<Text weight="semibold">粘贴 MCP 配置（可选）</Text>}>
        <VStack gap={1}>
          <TextArea label="MCP 配置" value={config} onChange={setConfig} rows={5} isDisabled={busy}
            placeholder={'{"mcpServers": {"erp": {"url": "https://…/mcp"}}}'} />
          <Text type="supporting">配置在企业端解析，里面的令牌直接丢弃，不会交给模型、不保存。</Text>
        </VStack>
      </Collapsible>
      <ModelPicker label="使用的模型" choices={models.choices} loading={models.loading} value={modelKey} onChange={setModelKey} isDisabled={busy}
        errorText={models.error ?? undefined} />
      {busy && <Banner status="info" title="模型正在查找…" description="最多约 90 秒，请不要关闭窗口。" />}
      {error && <Banner status="error" title={error} />}
    </VStack>
  );

  const results = result && (
    <VStack gap={3}>
      {result.incomplete && (
        <Banner status="warning" title="查找没有完全结束" description={result.error
          ? `模型服务中途出错（${result.error}），以下是已经找到的结果。`
          : "轮数、工具次数或时间用完了，以下是已经找到的结果；可以把需求写得更具体后重新查找。"} />
      )}
      {result.notes && <Text>{result.notes}</Text>}
      {result.candidates.length === 0
        ? <Text type="supporting">没有找到合适的候选。可以换个说法，或给一个已知链接再试。</Text>
        : (
          <VStack gap={2} aria-label="候选">
            {result.candidates.map((candidate) => <CandidateCard key={candidate.url} candidate={candidate} onUse={() => onUse(candidate)} />)}
          </VStack>
        )}
      {result.dropped > 0 && <Text type="supporting">另有 {result.dropped} 个候选的链接不在查找结果里（可能是模型编造的），已丢弃。</Text>}
      <Text type="supporting">
        本次用量：输入 {result.usage.input_tokens} / 输出 {result.usage.output_tokens} tokens，
        {result.usage.cost !== null ? `费用 $${result.usage.cost}` : "价格未知"}（计入企业负责人）。
      </Text>
    </VStack>
  );

  return (
    <Dialog isOpen purpose="form" width={720} aria-label="让模型帮我找" onOpenChange={close}>
      <Layout
        header={<DialogHeader title="让模型帮我找" onOpenChange={close} />}
        content={<LayoutContent>{results ?? form}</LayoutContent>}
        footer={
          <LayoutFooter hasDivider>
            <HStack justify="end" gap={2}>
              {result ? (
                <>
                  <Button label="重新查找" onClick={() => setResult(null)} />
                  <Button label="关闭" variant="primary" onClick={onClose} />
                </>
              ) : (
                <>
                  <Button label="取消" onClick={onClose} isDisabled={busy} />
                  <Button label="开始查找" variant="primary" isLoading={busy} isDisabled={!ready} onClick={() => void find()} />
                </>
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

function CandidateCard({ candidate, onUse }: { candidate: CapabilityAssistCandidate; onUse: () => void }): ReactNode {
  const scanners = candidate.security?.scanners ?? [];
  return (
    <VStack gap={1} aria-label={`候选 ${candidate.title}`} style={{ border: "1px solid var(--color-border)", borderRadius: 8, padding: 12 }}>
      <HStack gap={2} align="center" justify="between">
        <HStack gap={2} align="center" wrap="wrap" style={{ minWidth: 0, flex: 1 }}>
          <Text weight="semibold">{candidate.title}</Text>
          <Badge label={candidate.kind === "skill" ? "技能" : "MCP"} variant="info" />
          <Badge label={SOURCE_LABEL[candidate.source]} variant="neutral" />
          <Badge label={candidate.verified ? "已核实" : "未核实"} variant={candidate.verified ? "success" : "neutral"} />
          {scanners.map((scanner) => { const badge = scannerBadge(scanner); return <Badge key={scanner.name} label={badge.label} variant={badge.variant} />; })}
        </HStack>
        <Button label="用这个" onClick={onUse} />
      </HStack>
      {candidate.summary && <Text>{candidate.summary}</Text>}
      {candidate.reason && <Text type="supporting">推荐理由：{candidate.reason}</Text>}
      <Text type="supporting" style={{ overflowWrap: "anywhere" }}>{candidate.url}</Text>
    </VStack>
  );
}
