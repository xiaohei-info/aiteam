/**
 * 「导入技能」（企业端与运营端共用；设计 2026-11-20 §4.3 / §4.7）：选来源 → 检查 → 预览 / 多技能勾选 /
 * ClawHub 同名候选 / 安全扫描提示 / 跳过的文件 → 端上的设置 → 导入 → 结果分「成功 / 重复 / 失败」。
 * 与桌面端「添加技能 → 自定义」同一套规则；技能可带脚本和资料，不会自动执行。
 */
import { useRef, useState, type ReactNode } from "react";
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { FileInput } from "@astryxdesign/core/FileInput";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { ApiError } from "../api-client/index.js";
import type {
  SkillImportApi,
  SkillImportInput,
  SkillImportItem,
  SkillImportResponse,
  SkillImportResult,
  SkillImportSource,
  SkillSecurityScanner,
} from "./types.js";

type PickableSource = Exclude<SkillImportSource, "editor">;

const SOURCES: { id: PickableSource; label: string; hint: string }[] = [
  { id: "folder", label: "文件夹", hint: "选一个含 SKILL.md 的文件夹（可以带模板、脚本、参考资料）；一个文件夹里有多个技能时可勾选。" },
  { id: "zip", label: "zip", hint: "选一个技能压缩包（.zip）。" },
  { id: "file", label: "单个 .md", hint: "选一个 SKILL.md 文件；技能名取自文件里的 name，与文件名无关。" },
  { id: "text", label: "粘贴 SKILL.md", hint: "直接粘贴 SKILL.md 全文，只能做单文件技能。" },
  { id: "url", label: "网址", hint: "公开 https 地址：GitHub 仓库 / 子目录、单个 .md、zip。" },
  { id: "clawhub", label: "ClawHub", hint: "贴 ClawHub 技能页地址，例如 https://clawhub.ai/作者/skills/标识。" },
];

const SKIP_REASON: Record<string, string> = { platform_hook: "其他平台专用钩子", binary: "二进制文件", unsupported_path: "路径不支持" };
const SCANNER_LABEL: Record<string, string> = { skillspector: "静态扫描", llm: "模型复核", virustotal: "病毒扫描" };
const SCAN_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  clean: { label: "未发现风险", variant: "success" },
  benign: { label: "未发现风险", variant: "success" },
  suspicious: { label: "有可疑项", variant: "warning" },
  malicious: { label: "判定恶意", variant: "error" },
  pending: { label: "扫描中", variant: "neutral" },
};

export function scannerBadge(scanner: SkillSecurityScanner): { label: string; variant: BadgeVariant } {
  const status = SCAN_STATUS[scanner.status] ?? { label: "结论未知", variant: "neutral" as BadgeVariant };
  return { label: `${SCANNER_LABEL[scanner.name] ?? scanner.name}：${status.label}`, variant: status.variant };
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Astryx Text 的 color 没有错误色，直接用 Astryx 的 --color-error token。 */
const DANGER = { color: "var(--color-error)" } as const;

const UPLOADS = new Set(["folder", "zip", "file", "editor"]);

/** 粘贴 / 网址 / ClawHub：导入时带上检查到的内容哈希，来源在检查后变了就拒绝（上传的文件就是本地这份，不用带）。 */
function withExpectedHashes(input: SkillImportInput, chosen: SkillImportItem[]): SkillImportInput {
  if (UPLOADS.has(input.source)) return input;
  const expected = Object.fromEntries(chosen.filter((item) => item.content_hash).map((item) => [item.root, item.content_hash as string]));
  return Object.keys(expected).length === chosen.length ? { ...input, expected_hashes: expected } : input;
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 413) return "技能太大，超过上限（最多 256 个文件、共 10 MiB）。";
  if (err instanceof ApiError && err.status === 502) return `${err.message || "下载失败"}。请检查网址或稍后再试。`;
  return err instanceof Error && err.message ? err.message : fallback;
}

function existingBadge(item: SkillImportItem): { label: string; variant: BadgeVariant } {
  if (item.existing === "same") return { label: "目录里已有，内容相同", variant: "neutral" };
  if (item.existing === "update") return { label: `将升级 v${item.existing_version ?? "?"} → v${item.version}`, variant: "info" };
  return { label: "新增", variant: "success" };
}

/** 浏览器选的文件夹 → 文件 + 相对路径（webkitRelativePath，带顶层文件夹名）。 */
function folderFiles(list: FileList | null): { file: File; path: string }[] {
  return Array.from(list ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

export interface SkillImportDialogProps {
  api: SkillImportApi;
  onClose: () => void;
  /** 有技能写入目录后调用（用于刷新列表）。 */
  onImported: () => void;
  /** 从「让模型帮我找」带过来的链接：直接停在对应来源并填好地址，管理员点「检查」后照常导入。 */
  initial?: { source: "url" | "clawhub"; url: string };
  /** 可选的来源（默认全部；运营端没有 ClawHub，它有自己的外部市场）。 */
  sources?: PickableSource[];
  /** 新增技能的设置（企业端：成员可以自己安装）。 */
  settings?: ReactNode;
  /** 升级已有技能时的说明。 */
  updateNote?: string;
}

export function SkillImportDialog({
  api, onClose, onImported, initial, sources: allowed, settings, updateNote,
}: SkillImportDialogProps): ReactNode {
  const sourceList = allowed ? SOURCES.filter((item) => allowed.includes(item.id)) : SOURCES;
  const [source, setSource] = useState<PickableSource>(initial?.source ?? sourceList[0]!.id);
  const [folder, setFolder] = useState<{ file: File; path: string }[]>([]);
  const [archive, setArchive] = useState<File | null>(null);
  const [mdFile, setMdFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [checked, setChecked] = useState<{ input: SkillImportInput; response: SkillImportResponse } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<"check" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SkillImportResult[] | null>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const current = sourceList.find((item) => item.id === source) ?? sourceList[0]!;
  const items: SkillImportItem[] = checked?.response.preview ? [checked.response.preview] : checked?.response.scan ?? [];
  const candidates = checked?.response.clawhub?.candidates ?? null;
  const security = checked?.response.clawhub?.security ?? null;
  const risky = Boolean(security?.scanners.some((item) => item.status === "suspicious" || item.status === "malicious"));
  const multi = items.length > 1;
  const installable = items.filter((item) => item.ok && item.existing !== "same");
  const chosen = multi ? installable.filter((item) => picked.includes(item.root)) : installable;

  function resetCheck() {
    setChecked(null);
    setPicked([]);
    setError(null);
  }

  function inputFor(override?: Partial<SkillImportInput>): SkillImportInput | null {
    if (source === "folder") return folder.length ? { source, files: folder } : null;
    if (source === "zip") return archive ? { source, files: [{ file: archive, path: archive.name }] } : null;
    if (source === "file") return mdFile ? { source, files: [{ file: mdFile, path: mdFile.name }] } : null;
    if (source === "text") return text.trim() ? { source, text } : null;
    const value = (override?.url ?? url).trim();
    return value ? { source, url: value } : null;
  }

  async function check(override?: Partial<SkillImportInput>): Promise<void> {
    const input = inputFor(override);
    if (!input) return;
    setBusy("check");
    resetCheck();
    try {
      const response = await api.preview(input);
      if (!response) throw new Error("没有拿到检查结果");
      setChecked({ input, response });
      const scanned = response.preview ? [response.preview] : response.scan ?? [];
      setPicked(scanned.filter((item) => item.ok && item.existing !== "same").map((item) => item.root));
    } catch (err) {
      setError(errorText(err, "检查失败，请重试"));
    } finally {
      setBusy(null);
    }
  }

  async function runImport(): Promise<void> {
    if (!checked || chosen.length === 0) return;
    setBusy("import");
    setError(null);
    try {
      const response = await api.save(withExpectedHashes({ ...checked.input, roots: chosen.map((item) => item.root) }, chosen));
      const done = response?.results ?? [];
      setResults(done);
      if (done.some((item) => item.status === "installed" || item.status === "updated")) onImported();
    } catch (err) {
      if (err instanceof ApiError && err.code === "content_changed") {
        // 看到的那份已经过期：清掉检查结果，必须重新检查才能导入。
        setChecked(null);
        setPicked([]);
        setError("内容在检查之后有变化（例如仓库或 ClawHub 有了新版本），请重新检查后再导入。");
        return;
      }
      setError(errorText(err, "导入失败，请重试"));
    } finally {
      setBusy(null);
    }
  }

  function pickCandidate(candidateUrl: string) {
    setUrl(candidateUrl);
    void check({ url: candidateUrl });
  }

  const close = (open: boolean) => { if (!open && !busy) onClose(); };
  const ready = Boolean(inputFor());

  const sourceInput: ReactNode = source === "folder" ? (
    <VStack gap={1}>
      <HStack gap={2} align="center" wrap="wrap">
        <Button label="选择文件夹" size="sm" onClick={() => folderRef.current?.click()} isDisabled={Boolean(busy)} />
        <Text color="secondary">{folder.length ? `已选 ${folder[0]!.path.split("/")[0]}，共 ${folder.length} 个文件` : "尚未选择"}</Text>
      </HStack>
      <input
        ref={folderRef}
        type="file"
        aria-label="技能文件夹"
        multiple
        hidden
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(event) => { setFolder(folderFiles(event.currentTarget.files)); resetCheck(); event.currentTarget.value = ""; }}
      />
    </VStack>
  ) : source === "zip" ? (
    <FileInput label="技能压缩包" accept=".zip,application/zip" value={archive} onChange={(value) => { setArchive(Array.isArray(value) ? value[0] ?? null : value); resetCheck(); }} isDisabled={Boolean(busy)} />
  ) : source === "file" ? (
    <FileInput label="SKILL.md 文件" accept=".md,text/markdown" value={mdFile} onChange={(value) => { setMdFile(Array.isArray(value) ? value[0] ?? null : value); resetCheck(); }} isDisabled={Boolean(busy)} />
  ) : source === "text" ? (
    <TextArea label="SKILL.md 内容" value={text} onChange={(value) => { setText(value); resetCheck(); }} rows={8} isDisabled={Boolean(busy)}
      placeholder={"---\nname: weekly-report\ndescription: 把一周的工作整理成周报\n---\n"} />
  ) : (
    <VStack style={{ minWidth: 0 }}>
      <TextInput
        label={source === "url" ? "网址" : "ClawHub 地址"}
        value={url}
        onChange={(value) => { setUrl(value); resetCheck(); }}
        onEnter={() => { if (url.trim() && !busy) void check(); }}
        placeholder={source === "url" ? "https://github.com/作者/仓库/tree/main/技能目录" : "https://clawhub.ai/作者/skills/标识"}
        isDisabled={Boolean(busy)}
        width="100%"
      />
    </VStack>
  );

  const resultView = results && (
    <VStack gap={2} aria-label="导入结果">
      {(["installed", "updated", "duplicate", "failed"] as const).map((status) => {
        const group = results.filter((item) => item.status === status);
        if (!group.length) return null;
        const title = status === "installed" ? "已新增" : status === "updated" ? "已升级新版本" : status === "duplicate" ? "重复（未改动）" : "失败";
        return (
          <VStack key={status} gap={1}>
            <Text weight="semibold">{title} {group.length} 个</Text>
            {group.map((item) => (
              <Text key={`${status}-${item.root}`} style={status === "failed" ? DANGER : undefined}>
                {item.name || item.root || "技能"}{item.version ? ` v${item.version}` : ""}{item.reason ? `：${item.reason}` : ""}
              </Text>
            ))}
          </VStack>
        );
      })}
    </VStack>
  );

  return (
    <Dialog isOpen purpose="form" width={720} aria-label="导入技能" onOpenChange={close}>
      <Layout
        header={<DialogHeader title="导入技能" onOpenChange={close} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              {results ? resultView : (
                <>
                  <TabList aria-label="技能来源" value={source} onChange={(value) => { setSource(value as PickableSource); resetCheck(); }} hasDivider>
                    {sourceList.map((item) => <Tab key={item.id} value={item.id} label={item.label} />)}
                  </TabList>
                  <Text type="supporting">{current.hint}</Text>
                  {sourceInput}
                  <HStack gap={2}>
                    <Button label="检查" onClick={() => void check()} isLoading={busy === "check"} isDisabled={!ready || Boolean(busy)} />
                  </HStack>
                  {error && <Banner status="error" title={error} />}
                  {candidates && (
                    <VStack gap={1} aria-label="同名技能候选">
                      <Text>ClawHub 上有 {candidates.length} 个同名技能，选择作者：</Text>
                      {candidates.map((item) => (
                        <HStack key={item.owner} gap={2} align="center" wrap="wrap">
                          <Button label={`${item.owner}/${item.slug}`} size="sm" variant="secondary" onClick={() => pickCandidate(item.url)} isDisabled={Boolean(busy)} />
                          <Button label="在 ClawHub 查看" size="sm" variant="ghost" href={item.url} target="_blank" rel="noopener noreferrer" />
                        </HStack>
                      ))}
                    </VStack>
                  )}
                  {checked?.response.clawhub && !candidates && (
                    <VStack gap={2} aria-label="ClawHub 安全扫描">
                      <Text weight="semibold">ClawHub 安全扫描</Text>
                      <HStack gap={2} wrap="wrap">
                        {security?.scanners.length
                          ? security.scanners.map((scanner) => { const badge = scannerBadge(scanner); return <Badge key={scanner.name} label={badge.label} variant={badge.variant} />; })
                          : <Badge label="未取得扫描结论" variant="neutral" />}
                      </HStack>
                      {risky && <Banner status="warning" title="扫描提示有风险，仅供参考" description="导入不受扫描结论限制。请先看过脚本内容；员工运行任何命令仍按企业的审批策略执行。" />}
                    </VStack>
                  )}
                  {items.length > 0 && (
                    <VStack gap={2} aria-label={multi ? "包内技能清单" : "技能预览"}>
                      {multi && <Text weight="semibold">包里有 {items.length} 个技能，勾选要导入的：</Text>}
                      {items.map((item) => <SkillItem key={item.root || "root"} item={item} multi={multi} picked={picked.includes(item.root)} onPick={(on) => setPicked((prev) => on ? [...prev, item.root] : prev.filter((root) => root !== item.root))} disabled={Boolean(busy)} />)}
                      <Text type="supporting">技能可能附带脚本和资料，不会自动执行；员工运行命令仍按审批策略。</Text>
                    </VStack>
                  )}
                  {installable.length > 0 && (settings || (updateNote && installable.some((item) => item.existing === "update"))) && (
                    <VStack gap={2}>
                      {settings && <Text weight="semibold">新增技能的设置</Text>}
                      {settings}
                      {updateNote && installable.some((item) => item.existing === "update") && <Text type="supporting">{updateNote}</Text>}
                    </VStack>
                  )}
                </>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack justify="end" gap={2}>
              {results ? <Button label="完成" variant="primary" onClick={onClose} /> : (
                <>
                  <Button label="取消" onClick={onClose} isDisabled={Boolean(busy)} />
                  <Button
                    label={chosen.length > 1 ? `导入 ${chosen.length} 个` : "导入"}
                    variant="primary"
                    isLoading={busy === "import"}
                    isDisabled={!checked || chosen.length === 0 || Boolean(busy)}
                    onClick={() => void runImport()}
                  />
                </>
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

function SkillItem({ item, multi, picked, onPick, disabled }: { item: SkillImportItem; multi: boolean; picked: boolean; onPick: (on: boolean) => void; disabled: boolean }): ReactNode {
  const badge = existingBadge(item);
  const title = item.name || item.root || "SKILL.md";
  return (
    <VStack gap={1}>
      <HStack gap={2} align="center" wrap="wrap">
        {multi
          ? <CheckboxInput label={`${title}${item.ok ? ` · v${item.version}` : ""}`} value={picked && item.ok} onChange={onPick} isDisabled={disabled || !item.ok || item.existing === "same"} />
          : <Text weight="semibold">{title}{item.ok ? ` · v${item.version}` : ""}</Text>}
        {item.ok ? <Badge label={badge.label} variant={badge.variant} /> : <Badge label="不能导入" variant="error" />}
      </HStack>
      {item.ok ? <Text color="secondary">{item.description}</Text> : <Text style={DANGER}>{item.reason}</Text>}
      {item.ok && (
        <Collapsible defaultIsOpen={!multi} trigger={<Text type="supporting">将导入 {item.file_count} 个文件，共 {size(item.total_bytes)}</Text>}>
          <VStack gap={1}>
            {item.files.map((file) => (
              <HStack key={file.path} justify="between" gap={2}><Text>{file.path}</Text><Text color="secondary">{size(file.size)}</Text></HStack>
            ))}
          </VStack>
        </Collapsible>
      )}
      {item.skipped.length > 0 && (
        <VStack gap={1} aria-label={`${title} 跳过的文件`}>
          <Text type="supporting">跳过 {item.skipped.length} 个文件：</Text>
          {item.skipped.map((file) => (
            <HStack key={`skip-${file.path}`} justify="between" gap={2}><Text color="secondary">{file.path}</Text><Text color="secondary">{SKIP_REASON[file.reason] ?? file.reason}</Text></HStack>
          ))}
        </VStack>
      )}
    </VStack>
  );
}
