/**
 * 技能编辑器（企业端与运营端共用；设计 2026-11-20 §4.7）。
 *
 * 按技能本来的样子编辑：SKILL.md 的名称、说明（模型靠它决定什么时候用）、指令正文，加上附带文件
 * （scripts/、references/、assets/ 下的文本文件）。SKILL.md 里其余元数据原样保留。
 * 「设置」区由调用方传入（企业端：成员可以自己安装 / 停用）。
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
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
import {
  composeSkillMd,
  NEW_SKILL_BODY,
  parseSkillMd,
  skillDescriptionProblem,
  skillNameProblem,
} from "./skill-md.js";
import type { SkillFile } from "./types.js";

const MAX_FILES = 256;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd)$/i;
const REFERENCE_EXT = /\.(md|markdown|txt|rst)$/i;
const MONO = { fontFamily: "var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)" } as const;

export interface SkillEditorSaveInput {
  files: SkillFile[];
  /** SKILL.md 或附带文件有变化（只改了设置时为 false）。 */
  contentChanged: boolean;
}

export interface SkillEditorDialogProps {
  title: string;
  /** 已有技能的全部文件；新建时不传，用空白模板。 */
  files?: SkillFile[];
  /** 编辑已有技能时名称不能改：名称就是技能的身份，改名等于另建一个技能。 */
  isNameLocked?: boolean;
  /** 只能查看（例如企业端从平台技能市场装的技能）；给出原因。 */
  readOnlyReason?: string;
  /** 可编辑时顶部的说明（例如「保存后生成副本，原件保留」）。 */
  note?: string;
  /** 正文与文件下面的设置区。 */
  settings?: ReactNode;
  /** 端上额外的名称规则（如企业端 platform- 开头留给平台）。 */
  extraNameProblem?: (name: string) => string | null;
  /** 保存；返回错误文案，成功返回 null。 */
  onSave?: (input: SkillEditorSaveInput) => Promise<string | null>;
  onClose: () => void;
}

function byteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 选中的文件放进技能的哪个目录。技能包路径只允许英文字母、数字和 . _ -，
 * 其他字符（空格、中文）换成连字符；名字全被换掉时叫 file，扩展名保留。
 */
export function attachmentPath(fileName: string): string {
  const ext = /\.[A-Za-z0-9]{1,10}$/.exec(fileName)?.[0] ?? "";
  const base = fileName.slice(0, fileName.length - ext.length).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  const safe = `${base || "file"}${ext}`;
  const folder = SCRIPT_EXT.test(safe) ? "scripts" : REFERENCE_EXT.test(safe) ? "references" : "assets";
  return `${folder}/${safe}`;
}

/** 同名时：原样同名的文件替换（重新选了同一个文件），改过名的另起 -2、-3…，免得互相覆盖。 */
function placeAttachment(existing: SkillFile[], fileName: string): { path: string; replaces: boolean } {
  const path = attachmentPath(fileName);
  const taken = new Set(existing.map((item) => item.path));
  if (!taken.has(path)) return { path, replaces: false };
  if (path.endsWith(`/${fileName}`)) return { path, replaces: true };
  const dot = path.lastIndexOf(".");
  const [stem, ext] = dot > path.lastIndexOf("/") ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  let n = 2;
  while (taken.has(`${stem}-${n}${ext}`)) n += 1;
  return { path: `${stem}-${n}${ext}`, replaces: false };
}

/** 按 UTF-8 严格解码；不是文本（二进制）返回 null。 */
function readText(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(new TextDecoder("utf-8", { fatal: true }).decode(reader.result as ArrayBuffer));
      } catch {
        resolve(null);
      }
    };
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file);
  });
}

export function SkillEditorDialog({
  title, files, isNameLocked = false, readOnlyReason, note, settings, extraNameProblem, onSave, onClose,
}: SkillEditorDialogProps): ReactNode {
  const original = useMemo(() => {
    const skillMd = files?.find((file) => file.path === "SKILL.md")?.content;
    return {
      skillMd: skillMd ?? null,
      parts: skillMd != null ? parseSkillMd(skillMd) : { name: "", description: "", body: NEW_SKILL_BODY, extra: "" },
      attachments: (files ?? []).filter((file) => file.path !== "SKILL.md"),
    };
  }, [files]);
  const readOnly = Boolean(readOnlyReason);
  const [name, setName] = useState(original.parts.name);
  const [description, setDescription] = useState(original.parts.description);
  const [body, setBody] = useState(original.parts.body);
  const [attachments, setAttachments] = useState<SkillFile[]>(original.attachments);
  const [showProblems, setShowProblems] = useState(false);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const nameProblem = skillNameProblem(name) ?? extraNameProblem?.(name.trim()) ?? null;
  const descriptionProblem = skillDescriptionProblem(description);
  const skillMd = composeSkillMd({ name, description, body, extra: original.parts.extra });
  const contentChanged = skillMd !== original.skillMd
    || attachments.length !== original.attachments.length
    || attachments.some((file, index) => file.path !== original.attachments[index]?.path || file.content !== original.attachments[index]?.content);
  const totalBytes = byteSize(skillMd) + attachments.reduce((sum, file) => sum + byteSize(file.content), 0);

  async function addFiles(list: FileList | null): Promise<void> {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    const next = [...attachments];
    const notes: string[] = [];
    for (const file of picked) {
      if (file.size > MAX_FILE_BYTES) { notes.push(`${file.name} 超过 5 MB`); continue; }
      const content = await readText(file);
      if (content == null) { notes.push(`${file.name} 不是文本文件（技能只能带脚本、说明、模板等文本文件）`); continue; }
      const { path, replaces } = placeAttachment(next, file.name);
      if (replaces) { next[next.findIndex((item) => item.path === path)] = { path, content }; notes.push(`${path} 已替换`); }
      else next.push({ path, content });
    }
    if (next.length + 1 > MAX_FILES) { setFileNotice(`最多 ${MAX_FILES} 个文件`); return; }
    const total = byteSize(skillMd) + next.reduce((sum, item) => sum + byteSize(item.content), 0);
    if (total > MAX_TOTAL_BYTES) { setFileNotice("技能总大小超过 10 MB，未添加"); return; }
    setAttachments(next.sort((a, b) => a.path.localeCompare(b.path)));
    setFileNotice(notes.length ? notes.join("；") : null);
  }

  async function save(): Promise<void> {
    if (!onSave) return;
    setShowProblems(true);
    if (!readOnly && (nameProblem || descriptionProblem)) return;
    setSaving(true);
    setError(null);
    try {
      const message = await onSave({ files: [{ path: "SKILL.md", content: skillMd }, ...attachments], contentChanged });
      if (message) setError(message);
    } finally {
      setSaving(false);
    }
  }

  const close = (open: boolean) => { if (!open && !saving) onClose(); };

  return (
    <Dialog isOpen purpose="form" width={760} aria-label={title} onOpenChange={close}>
      <Layout
        header={<DialogHeader title={title} onOpenChange={close} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              {(readOnlyReason || note) && <Banner status="info" title={readOnlyReason || note} />}
              {error && <Banner status="error" title={error} />}
              <TextInput
                label="名称"
                description="技能的 name：小写字母、数字和连字符。员工和模型用它指代这个技能。"
                value={name}
                onChange={setName}
                placeholder="weekly-report"
                isDisabled={readOnly || isNameLocked || saving}
                status={showProblems && nameProblem ? { type: "error", message: nameProblem } : undefined}
              />
              <TextArea
                label="说明"
                description="做什么、什么时候用。模型只看这句话决定要不要用这个技能，写具体些（最多 1024 字）。"
                value={description}
                onChange={setDescription}
                rows={3}
                placeholder="把一周的工作整理成周报。用户要写周报、周总结时使用。"
                isDisabled={readOnly || saving}
                status={showProblems && descriptionProblem ? { type: "error", message: descriptionProblem } : undefined}
              />
              <TextArea
                label="指令"
                description="员工用这个技能时读到的完整说明（Markdown）。提到附带文件时写相对路径，如 scripts/fill.sh。"
                value={body}
                onChange={setBody}
                rows={14}
                isDisabled={readOnly || saving}
              />
              <VStack gap={2} aria-label="附带文件">
                <HStack justify="between" align="center" gap={2} wrap="wrap">
                  <Text weight="semibold">附带文件（{attachments.length}）</Text>
                  {!readOnly && <Button label="添加文件" size="sm" onClick={() => fileRef.current?.click()} isDisabled={saving} />}
                </HStack>
                <Text type="supporting">可带脚本、参考资料、模板（文本文件），放在 scripts/、references/、assets/ 下。不会自动执行；员工运行命令仍按审批策略。</Text>
                <input
                  ref={fileRef}
                  type="file"
                  aria-label="选择要附带的文件"
                  multiple
                  hidden
                  onChange={(event) => { const list = event.currentTarget.files; void addFiles(list); event.currentTarget.value = ""; }}
                />
                {fileNotice && <Banner status="warning" title={fileNotice} />}
                {attachments.length === 0 ? <Text color="secondary">没有附带文件</Text> : attachments.map((file) => (
                  <HStack key={file.path} justify="between" align="start" gap={2}>
                    <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                      <Collapsible defaultIsOpen={false} trigger={<Text style={MONO}>{file.path} · {sizeLabel(byteSize(file.content))}</Text>}>
                        <pre style={{ ...MONO, margin: 0, maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 12 }}>{file.content}</pre>
                      </Collapsible>
                    </div>
                    {!readOnly && (
                      <Button label="移除" size="sm" variant="ghost" isDisabled={saving}
                        onClick={() => setAttachments((prev) => prev.filter((item) => item.path !== file.path))} />
                    )}
                  </HStack>
                ))}
                <Text type="supporting">共 {sizeLabel(totalBytes)}（上限 10 MB、{MAX_FILES} 个文件）</Text>
              </VStack>
              {settings && (
                <VStack gap={2}>
                  <Text weight="semibold">设置</Text>
                  {settings}
                </VStack>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack justify="end" gap={2}>
              {onSave ? (
                <>
                  <Button label="取消" onClick={onClose} isDisabled={saving} />
                  <Button label="保存" variant="primary" onClick={() => void save()} isLoading={saving} />
                </>
              ) : <Button label="关闭" variant="primary" onClick={onClose} />}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
