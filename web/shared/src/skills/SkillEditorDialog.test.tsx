import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { attachmentPath, SkillEditorDialog } from "./SkillEditorDialog.js";
import { parseSkillMd } from "./skill-md.js";

const SKILL = "---\nname: weekly-report\ndescription: 生成周报。用户要写周报时使用。\nlicense: MIT\n---\n# 周报\n";
const FILES = [{ path: "SKILL.md", content: SKILL }, { path: "scripts/fill.sh", content: "echo hi\n" }];

function dialog() {
  return screen.getByRole("dialog");
}

describe("SkillEditorDialog", () => {
  it("按技能本身编辑：名称 / 说明 / 指令 / 附带文件；没有安装策略、JSON 等无效字段", () => {
    render(<SkillEditorDialog title="编辑技能" files={FILES} isNameLocked onSave={vi.fn()} onClose={vi.fn()} />);
    const view = within(dialog());
    expect(view.getByRole("textbox", { name: /^名称/ })).toHaveValue("weekly-report");
    expect(view.getByRole("textbox", { name: /^名称/ })).toBeDisabled();
    expect(view.getByRole("textbox", { name: /^说明/ })).toHaveValue("生成周报。用户要写周报时使用。");
    expect(view.getByRole("textbox", { name: "指令" })).toHaveValue("# 周报\n");
    expect(view.getByText("scripts/fill.sh · 8 B")).toBeInTheDocument();
    for (const gone of [/安装策略/, /绑定策略/, /JSON/, /可见性/]) expect(view.queryByText(gone)).toBeNull();
  });

  it("改说明、移除文件、添加文本文件后保存：其余元数据保留，二进制文件被拒", async () => {
    const onSave = vi.fn().mockResolvedValue(null);
    render(<SkillEditorDialog title="编辑技能" files={FILES} isNameLocked onSave={onSave} onClose={vi.fn()} />);
    const view = within(dialog());
    fireEvent.change(view.getByRole("textbox", { name: /^说明/ }), { target: { value: "生成周报: 先读 references/tpl.md" } });
    fireEvent.click(view.getByRole("button", { name: "移除" }));
    const input = view.getByLabelText("选择要附带的文件");
    const text = new File(["# 模板\n"], "周报 模板.md", { type: "text/markdown" });
    const binary = new File([new Uint8Array([0x89, 0x50, 0xff, 0xfe, 0x00])], "logo.png");
    fireEvent.change(input, { target: { files: [text, binary] } });
    expect(await view.findByText(/logo\.png 不是文本文件/)).toBeInTheDocument();
    expect(view.getByText(/references\/file\.md/)).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const { files, contentChanged } = onSave.mock.calls[0]![0];
    expect(contentChanged).toBe(true);
    expect(files.map((f: { path: string }) => f.path)).toEqual(["SKILL.md", "references/file.md"]);
    const parts = parseSkillMd(files[0].content);
    expect(parts.description).toBe("生成周报: 先读 references/tpl.md");
    expect(parts.extra).toBe("license: MIT");
    expect(files[0].content).toContain('description: "生成周报: 先读 references/tpl.md"');
  });

  it("新建：空白模板，名称或说明不合规时不保存并就地提示", async () => {
    const onSave = vi.fn().mockResolvedValue("服务端拒绝");
    render(<SkillEditorDialog title="从零写一个" onSave={onSave} onClose={vi.fn()} extraNameProblem={(name) => name.startsWith("platform-") ? "保留给平台" : null} />);
    const view = within(dialog());
    expect((view.getByRole("textbox", { name: "指令" }) as HTMLTextAreaElement).value).toContain("# 怎么做");
    fireEvent.change(view.getByRole("textbox", { name: /^名称/ }), { target: { value: "Weekly Report" } });
    fireEvent.click(view.getByRole("button", { name: "保存" }));
    expect(await view.findByText("名称只能用小写字母、数字和单个连字符（如 weekly-report）")).toBeInTheDocument();
    expect(view.getByText("请写清楚这个技能做什么、什么时候用")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(view.getByRole("textbox", { name: /^名称/ }), { target: { value: "platform-x" } });
    expect(await view.findByText("保留给平台")).toBeInTheDocument();
    fireEvent.change(view.getByRole("textbox", { name: /^名称/ }), { target: { value: "weekly-report" } });
    fireEvent.change(view.getByRole("textbox", { name: /^说明/ }), { target: { value: "生成周报" } });
    fireEvent.click(view.getByRole("button", { name: "保存" }));
    expect(await view.findByText("服务端拒绝")).toBeInTheDocument();  // 失败留在弹窗里
  });

  it("只读：内容不能改，没有 onSave 时只有「关闭」", () => {
    render(<SkillEditorDialog title="查看技能" files={FILES} readOnlyReason="平台技能只能查看" onClose={vi.fn()} />);
    const view = within(dialog());
    expect(view.getByText("平台技能只能查看")).toBeInTheDocument();
    expect(view.getByRole("textbox", { name: /^说明/ })).toBeDisabled();
    expect(view.queryByRole("button", { name: "添加文件" })).toBeNull();
    expect(view.queryByRole("button", { name: "移除" })).toBeNull();
    expect(view.getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });

  it("附带文件按类型放进 scripts / references / assets，非法字符换成连字符", () => {
    expect(attachmentPath("fill.sh")).toBe("scripts/fill.sh");
    expect(attachmentPath("guide.md")).toBe("references/guide.md");
    expect(attachmentPath("schema.json")).toBe("assets/schema.json");
    expect(attachmentPath(".env")).toBe("assets/file.env");
    expect(attachmentPath("周报 模板.md")).toBe("references/file.md");
    expect(attachmentPath("my report v2.txt")).toBe("references/my-report-v2.txt");
  });
});
