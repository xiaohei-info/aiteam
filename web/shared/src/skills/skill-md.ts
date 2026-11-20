/**
 * SKILL.md 的读写：把文件拆成「名称 / 说明 / 指令」三块给表单编辑，保存时再拼回去。
 *
 * 规则跟 Agent Skills 规范（pi 同口径）：
 * - 开头 `---` 之间是元数据，`name`（小写字母、数字、单个连字符，≤ 64）与 `description`（≤ 1024，
 *   写清楚做什么、什么时候用——模型靠它决定要不要用这个技能）必填；
 * - 其余元数据（license、compatibility、metadata、allowed-tools、version…）原样保留，表单不改；
 * - `---` 之后是指令正文（Markdown）。
 * 服务端仍做完整 YAML 校验；这里只负责可靠地拆与拼。
 */
import type { SkillFile } from "./types.js";

export interface SkillMdParts {
  name: string;
  description: string;
  /** 指令正文（`---` 之后）。 */
  body: string;
  /** 其余元数据原文（每行一条或多行块），保存时原样写回。 */
  extra: string;
}

export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// 与服务端（shared/skill_package.py）同一个分隔规则。
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** 新建技能时的指令模板。 */
export const NEW_SKILL_BODY = "\n# 怎么做\n\n1. \n\n# 注意\n\n- \n";

export function parseSkillMd(text: string): SkillMdParts {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { name: "", description: "", body: text, extra: "" };
  const blocks = topLevelBlocks(match[1] ?? "");
  let name = "";
  let description = "";
  const extra: string[] = [];
  for (const block of blocks) {
    if (block.key === "name") name = scalarValue(block.lines);
    else if (block.key === "description") description = scalarValue(block.lines);
    else extra.push(block.lines.join("\n"));
  }
  return { name, description, body: text.slice(match[0].length), extra: extra.join("\n").trim() };
}

export function composeSkillMd(parts: SkillMdParts): string {
  const head = [`name: ${yamlScalar(parts.name.trim())}`, `description: ${yamlScalar(parts.description.trim())}`];
  if (parts.extra.trim()) head.push(parts.extra.trim());
  return `---\n${head.join("\n")}\n---\n${parts.body}`;
}

/** 名称不合规时返回原因（中文），合规返回 null。 */
export function skillNameProblem(name: string): string | null {
  const value = name.trim();
  if (!value) return "请填写名称";
  if (value.length > SKILL_NAME_MAX) return `名称不超过 ${SKILL_NAME_MAX} 个字符`;
  if (!NAME_RE.test(value)) return "名称只能用小写字母、数字和单个连字符（如 weekly-report）";
  return null;
}

export function skillDescriptionProblem(description: string): string | null {
  const value = description.trim();
  if (!value) return "请写清楚这个技能做什么、什么时候用";
  if (value.length > SKILL_DESCRIPTION_MAX) return `说明不超过 ${SKILL_DESCRIPTION_MAX} 个字`;
  return null;
}

/** 从技能文件里读出 SKILL.md 的名称与说明（列表展示用）；没有 SKILL.md 时为空。 */
export function skillSummary(files: SkillFile[] | null | undefined): { name: string; description: string } {
  const skillMd = files?.find((file) => file.path === "SKILL.md");
  if (!skillMd) return { name: "", description: "" };
  const parts = parseSkillMd(skillMd.content);
  return { name: parts.name, description: parts.description };
}

interface Block {
  key: string;
  lines: string[];
}

/** 顶层键值块：键行 + 其后缩进或空白的续行（块标量、嵌套映射、列表）。 */
function topLevelBlocks(frontmatter: string): Block[] {
  const blocks: Block[] = [];
  for (const line of frontmatter.split(/\r?\n/)) {
    const top = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (top && !/^\s/.test(line)) blocks.push({ key: top[1]!, lines: [line] });
    else if (blocks.length) blocks[blocks.length - 1]!.lines.push(line);
    else if (line.trim()) blocks.push({ key: "", lines: [line] });
  }
  return blocks;
}

function scalarValue(lines: string[]): string {
  const first = lines[0]!.replace(/^[^:]*:\s*/, "");
  const rest = lines.slice(1);
  const indicator = /^([|>])([+-]?)\s*(?:#.*)?$/.exec(first.trim());
  if (indicator) {
    const content = dedent(rest);
    const text = indicator[1] === "|" ? content.join("\n") : fold(content);
    return text.trim();
  }
  const inline = first.trim();
  if (inline.startsWith('"')) {
    const joined = [inline, ...rest.map((line) => line.trim())].join(" ");
    try {
      return JSON.parse(joined) as string;
    } catch {
      return joined.replace(/^"|"$/g, "");
    }
  }
  if (inline.startsWith("'")) {
    const joined = [inline, ...rest.map((line) => line.trim())].join(" ");
    return joined.replace(/^'|'$/g, "").replace(/''/g, "'");
  }
  // 普通标量可以跨行：续行折成空格。
  return [inline.replace(/\s+#.*$/, ""), ...rest.map((line) => line.trim())].filter(Boolean).join(" ");
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((line) => line.trim()).map((line) => /^\s*/.exec(line)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(cut));
}

/** `>` 折叠块：相邻非空行合成一行，空行保留为换行。 */
function fold(lines: string[]): string {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim()) current.push(line.trim());
    else {
      if (current.length) out.push(current.join(" "));
      current = [];
      out.push("");
    }
  }
  if (current.length) out.push(current.join(" "));
  return out.join("\n");
}

/** 写回 YAML：能写成普通标量就不加引号，否则用双引号（JSON 字符串也是合法的 YAML 双引号标量）。 */
function yamlScalar(value: string): string {
  const plain =
    value !== "" &&
    !/[\n\r\t]/.test(value) &&
    !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !/\s$/.test(value) &&
    !/:\s|\s#|:$/.test(value) &&
    !/^(true|false|yes|no|on|off|null|~|[-+]?[0-9][0-9._eE+-]*)$/i.test(value);
  return plain ? value : JSON.stringify(value);
}
