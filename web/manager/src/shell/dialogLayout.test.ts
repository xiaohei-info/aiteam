import { describe, expect, it } from "vitest";

// 弹窗结构守卫（可达性）：Astryx Dialog 内容超过 maxHeight 时直接裁掉、不会滚动，底部按钮会被裁到看不见、点不到。
// 只有 Dialog 的直接子元素是 Layout 且用默认 height="fill" 时，标题和底部按钮才固定、中间内容滚动。
// 因此：每个 <Dialog> 的第一个子元素必须是 <Layout>，且不得写 height="auto"（auto 会撑破弹窗再被裁掉）。
const sources = import.meta.glob(["../**/*.tsx", "!../**/*.test.tsx"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** 子元素原样透传给 Dialog 的外壳：调用方传入的 children 已经是 Layout。 */
const PASSTHROUGH_FRAMES = new Set<string>(["../features/knowledge/DocumentsPanel.tsx"]);

function tagEnd(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const c = source[i];
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (c === ">" && depth === 0) return i;
  }
  return -1;
}

export function dialogLayoutProblems(file: string, source: string): string[] {
  const problems: string[] = [];
  for (const match of source.matchAll(/<Dialog\b/g)) {
    const end = tagEnd(source, match.index + match[0].length);
    const line = source.slice(0, match.index).split("\n").length;
    if (end < 0 || source[end - 1] === "/") continue;
    const rest = source.slice(end + 1).replace(/^(\s|\{\/\*[\s\S]*?\*\/\})*/, "");
    if (rest.startsWith("{children}") && PASSTHROUGH_FRAMES.has(file)) continue;
    if (!/^<Layout\b/.test(rest)) {
      problems.push(`${file}:${line} Dialog 的第一个子元素必须是 <Layout>（header / content / footer）`);
      continue;
    }
    const layoutTag = rest.slice(0, tagEnd(rest, "<Layout".length) + 1);
    if (/height=("auto"|\{"auto"\})/.test(layoutTag)) problems.push(`${file}:${line} 弹窗里的 Layout 不能用 height="auto"，内容多时会被裁掉`);
  }
  return problems;
}

describe("弹窗结构：内容再多，标题与底部按钮也始终可见、可点", () => {
  it("每个 Dialog 都用 Layout 承载，且不撑破高度", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    expect(Object.entries(sources).flatMap(([file, source]) => dialogLayoutProblems(file, source))).toEqual([]);
  });

  it("能识别出会把按钮裁掉的写法", () => {
    expect(dialogLayoutProblems("x.tsx", '<Dialog isOpen>\n  <VStack><Button label="确定" /></VStack>\n</Dialog>')).toHaveLength(1);
    expect(dialogLayoutProblems("x.tsx", '<Dialog isOpen>\n  <Layout height="auto" content={<div />} />\n</Dialog>')).toHaveLength(1);
    expect(dialogLayoutProblems("x.tsx", '<Dialog isOpen>\n  {/* 说明 */}\n  <Layout header={<DialogHeader title="t" />} content={<div />} />\n</Dialog>')).toEqual([]);
  });
});
