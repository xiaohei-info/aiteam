/**
 * 技能市场与技能选择器共用的部件：安全扫描标签、导入前预览弹窗、ClawHub 链接导入。
 * 设计 2026-11-20 §4.2：扫描结论两个扫描器并列展示、只提示不拦截；导入前先看清会导入/跳过哪些文件。
 */
import { useEffect, useState, type ReactNode } from "react";
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { errorText } from "./useExternalSkills";
import type { useSkillMarketApi } from "./useSkillMarketApi";
import type { ClawHubCandidate, ExternalSkillPreview, SkillSecurity, SkillSecurityScanner, SkippedFile } from "./types";

type Api = ReturnType<typeof useSkillMarketApi>;

const SCANNER_LABEL: Record<string, string> = { skillspector: "静态扫描", llm: "模型复核", virustotal: "病毒扫描" };

const STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  clean: { label: "未发现风险", variant: "success" },
  benign: { label: "未发现风险", variant: "success" },
  suspicious: { label: "有可疑项", variant: "warning" },
  malicious: { label: "判定恶意", variant: "error" },
  pending: { label: "扫描中", variant: "neutral" },
};

export const SKIP_REASON: Record<SkippedFile["reason"], string> = {
  platform_hook: "其他平台专用钩子",
  binary: "二进制文件",
  unsupported_path: "路径不支持",
};

function scannerBadge(scanner: SkillSecurityScanner): { label: string; variant: BadgeVariant } {
  const status = STATUS[scanner.status] ?? { label: "结论未知", variant: "neutral" as BadgeVariant };
  return { label: `${SCANNER_LABEL[scanner.name] ?? scanner.name}：${status.label}`, variant: status.variant };
}

export function hasRisk(security: SkillSecurity | null | undefined): boolean {
  return Boolean(security?.scanners.some((item) => item.status === "suspicious" || item.status === "malicious"));
}

/** 每个扫描器一个标签；没有结论时显示「未取得扫描结论」。 */
export function SecurityBadges({ security }: { security: SkillSecurity | null | undefined }): ReactNode {
  if (!security || security.scanners.length === 0) return <Badge label="未取得扫描结论" variant="neutral" />;
  return (
    <>
      {security.scanners.map((scanner) => {
        const badge = scannerBadge(scanner);
        return <Badge key={scanner.name} label={badge.label} variant={badge.variant} />;
      })}
    </>
  );
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

interface SkillPreviewDialogProps {
  api: Api;
  owner: string;
  slug: string;
  /** 确认按钮文字，如「导入」「导入并选择」。 */
  confirmLabel: string;
  onConfirm: (preview: ExternalSkillPreview) => Promise<void>;
  onClose: () => void;
}

/** 下载并校验后展示将导入的文件、跳过的文件与扫描结论；确认后才写入平台目录。 */
export function SkillPreviewDialog({ api, owner, slug, confirmLabel, onConfirm, onClose }: SkillPreviewDialogProps): ReactNode {
  const [preview, setPreview] = useState<ExternalSkillPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setPreview(null);
    setError(null);
    api.preview(owner, slug)
      .then((data) => { if (active) data ? setPreview(data) : setError("ClawHub 没有返回预览"); })
      .catch((err) => { if (active) setError(errorText(err, "技能预览失败")); });
    return () => { active = false; };
  }, [api, owner, slug, attempt]);

  const current = Boolean(preview && preview.imported_version === preview.version);

  async function confirm(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(preview);
    } catch (err) {
      setError(errorText(err, "技能导入失败"));
      setBusy(false);
    }
  }

  const close = (open: boolean) => { if (!open && !busy) onClose(); };

  return (
    <Dialog isOpen purpose="form" width={680} aria-label="预览 ClawHub 技能" onOpenChange={close}>
      <Layout
        header={<DialogHeader title={preview ? `预览 ${preview.display_name}` : `预览 ${owner}/${slug}`} onOpenChange={close} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              {!preview && !error && <HStack gap={2} align="center"><Spinner size="sm" /><Text color="secondary">正在从 ClawHub 下载并核对文件…</Text></HStack>}
              {error && <Banner status="error" title={error} endContent={!preview ? <Button label="重试" variant="ghost" size="sm" onClick={() => setAttempt((n) => n + 1)} /> : undefined} />}
              {preview && (
                <>
                  <VStack gap={1}>
                    <Text color="secondary">{preview.owner}/{preview.slug} · v{preview.version}</Text>
                    {preview.summary && <Text>{preview.summary}</Text>}
                    {preview.imported_version && (
                      <Text color="secondary">{current ? "平台目录里已经是这个版本。" : `平台目录里已有 v${preview.imported_version}，确认后导入 v${preview.version}。`}</Text>
                    )}
                  </VStack>
                  <VStack gap={2}>
                    <Text weight="semibold">ClawHub 安全扫描</Text>
                    <HStack gap={2} wrap="wrap"><SecurityBadges security={preview.security} /></HStack>
                    {hasRisk(preview.security) && (
                      <Banner status="warning" title="扫描提示有风险，仅供参考" description="导入不受扫描结论限制。请先看过脚本内容；员工运行任何命令仍按企业的审批策略执行。" />
                    )}
                  </VStack>
                  <VStack gap={1}>
                    <Text weight="semibold">将导入 {preview.files.length} 个文件，共 {size(preview.total_bytes)}</Text>
                    {preview.files.map((file) => (
                      <HStack key={file.path} justify="between" gap={2}>
                        <Text>{file.path}</Text>
                        <Text color="secondary">{size(file.size)}</Text>
                      </HStack>
                    ))}
                  </VStack>
                  {preview.skipped.length > 0 && (
                    <VStack gap={1}>
                      <Text weight="semibold">跳过 {preview.skipped.length} 个文件</Text>
                      {preview.skipped.map((file) => (
                        <HStack key={file.path} justify="between" gap={2}>
                          <Text>{file.path}</Text>
                          <Text color="secondary">{SKIP_REASON[file.reason] ?? file.reason}</Text>
                        </HStack>
                      ))}
                    </VStack>
                  )}
                </>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack justify="between" gap={2} align="center">
              {preview ? <Button label="在 ClawHub 查看" href={preview.canonical_url} variant="ghost" size="sm" /> : <span />}
              <HStack gap={2}>
                <Button label="取消" onClick={onClose} isDisabled={busy} />
                <Button label={current ? "已导入" : confirmLabel} variant="primary" isLoading={busy} isDisabled={!preview || current} onClick={() => void confirm()} />
              </HStack>
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

/** 粘贴 ClawHub 技能页地址；地址没写作者时列出同名技能让运营选。 */
export function ClawHubLinkImport({ api, disabled, onPick }: { api: Api; disabled?: boolean; onPick: (owner: string, slug: string) => void }): ReactNode {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ClawHubCandidate[]>([]);

  async function resolve(): Promise<void> {
    setBusy(true);
    setError(null);
    setCandidates([]);
    try {
      const result = await api.resolve(url.trim());
      if (result?.owner) onPick(result.owner, result.slug);
      else if (result?.candidates.length) setCandidates(result.candidates);
      else setError("ClawHub 上找不到这个技能");
    } catch (err) {
      setError(errorText(err, "地址解析失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <VStack gap={2}>
      <HStack gap={2} align="end">
        <TextInput
          label="按链接导入"
          value={url}
          onChange={setUrl}
          placeholder="https://clawhub.ai/作者/skills/标识"
          isOptional
          isDisabled={disabled}
        />
        <Button label="预览" onClick={() => void resolve()} isLoading={busy} isDisabled={disabled || !url.trim()} />
      </HStack>
      {error && <Banner status="error" title={error} />}
      {candidates.length > 0 && (
        <VStack gap={1}>
          <Text color="secondary">有 {candidates.length} 个同名技能，选择作者：</Text>
          <HStack gap={2} wrap="wrap">
            {candidates.map((item) => <Button key={item.owner} label={`${item.owner}/${item.slug}`} size="sm" variant="ghost" onClick={() => { setCandidates([]); onPick(item.owner, item.slug); }} />)}
          </HStack>
        </VStack>
      )}
    </VStack>
  );
}
