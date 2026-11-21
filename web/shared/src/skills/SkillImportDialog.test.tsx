import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api-client/index.js";
import { scannerBadge, SkillImportDialog } from "./SkillImportDialog.js";
import type { SkillImportApi, SkillImportItem, SkillImportResponse } from "./types.js";

function item(over: Partial<SkillImportItem> = {}): SkillImportItem {
  return {
    root: "", ok: true, name: "weekly-report", description: "生成周报。写周报时使用。", version: "abc123",
    file_count: 2, total_bytes: 2048, files: [{ path: "SKILL.md", size: 120 }, { path: "scripts/run.sh", size: 2 * 1024 * 1024 }],
    skipped: [], existing: "none", ...over,
  };
}

const ORIGIN = { kind: "text", label: "粘贴" };

function setup(preview: SkillImportResponse | Error | null, save: SkillImportResponse | Error | null = { origin: ORIGIN, results: [] }, props: Partial<Parameters<typeof SkillImportDialog>[0]> = {}) {
  const api: SkillImportApi = {
    preview: vi.fn(async () => { if (preview instanceof Error) throw preview; return preview; }),
    save: vi.fn(async () => { if (save instanceof Error) throw save; return save; }),
  };
  const onClose = vi.fn();
  const onImported = vi.fn();
  render(<SkillImportDialog api={api} onClose={onClose} onImported={onImported} {...props} />);
  return { api, onClose, onImported, view: within(screen.getByRole("dialog", { name: "导入技能" })) };
}

function tab(name: string) {
  fireEvent.click(document.querySelector<HTMLElement>(`[data-tab-value="${name}"]`)!);
}

describe("SkillImportDialog", () => {
  it("粘贴 SKILL.md：检查后预览文件与大小，导入后分组显示结果并通知刷新", async () => {
    const { api, onImported, onClose, view } = setup(
      { origin: ORIGIN, preview: item() },
      { origin: ORIGIN, results: [
        { root: "", name: "weekly-report", version: "abc123", status: "installed" },
        { root: "x", name: "", version: "", status: "failed", reason: "缺少 SKILL.md" },
      ] },
    );
    tab("text");
    expect(view.getByRole("button", { name: "检查" })).toBeDisabled();
    fireEvent.change(view.getByRole("textbox", { name: "SKILL.md 内容" }), { target: { value: "---\nname: weekly-report\n---\n" } });
    fireEvent.click(view.getByRole("button", { name: "检查" }));
    expect(await view.findByText("weekly-report · vabc123")).toBeInTheDocument();
    expect(view.getByText("新增")).toBeInTheDocument();
    expect(view.getByText("将导入 2 个文件，共 2.0 KB")).toBeInTheDocument();
    expect(view.getByText("2.00 MB")).toBeInTheDocument();
    expect(view.getByText("120 B")).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "导入" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ source: "text", text: "---\nname: weekly-report\n---\n", roots: [""] }));
    expect(await view.findByText("已新增 1 个")).toBeInTheDocument();
    expect(view.getByText("失败 1 个")).toBeInTheDocument();
    expect(view.getByText("x：缺少 SKILL.md")).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: "完成" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("文件夹里有多个技能：可勾选，已有相同内容的不能选，不能导入的显示原因，跳过的文件列出", async () => {
    const scan = [
      item({ root: "a", name: "a" }),
      item({ root: "b", name: "b", existing: "update", existing_version: "v1", version: "v2", skipped: [{ path: "b/hooks/openclaw/x.js", reason: "platform_hook" }, { path: "b/logo.png", reason: "binary" }, { path: "b/odd", reason: "weird" }] }),
      item({ root: "c", name: "c", existing: "same" }),
      item({ root: "d", name: "", ok: false, reason: "SKILL.md 缺少 description" }),
    ];
    const { api, onImported, view } = setup(
      { origin: { kind: "folder", label: "文件夹" }, scan },
      { origin: ORIGIN, results: [{ root: "a", name: "a", version: "abc123", status: "duplicate" }] },
      { settings: <span>成员可以自己安装</span>, updateNote: "升级后专家用新版本" },
    );
    const folder = view.getByLabelText("技能文件夹") as HTMLInputElement;
    const file = (path: string) => { const f = new File(["x"], path.split("/").pop()!); Object.defineProperty(f, "webkitRelativePath", { value: path }); return f; };
    fireEvent.change(folder, { target: { files: [file("pack/a/SKILL.md"), file("pack/b/SKILL.md")] } });
    expect(view.getByText("已选 pack，共 2 个文件")).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "检查" }));
    expect(await view.findByText("包里有 4 个技能，勾选要导入的：")).toBeInTheDocument();
    expect(view.getByText("将升级 vv1 → vv2")).toBeInTheDocument();
    expect(view.getByText("目录里已有，内容相同")).toBeInTheDocument();
    expect(view.getByText("SKILL.md 缺少 description")).toBeInTheDocument();
    expect(view.getByText("不能导入")).toBeInTheDocument();
    const skipped = within(view.getByLabelText("b 跳过的文件"));
    expect(skipped.getByText("其他平台专用钩子")).toBeInTheDocument();
    expect(skipped.getByText("二进制文件")).toBeInTheDocument();
    expect(skipped.getByText("weird")).toBeInTheDocument();
    expect(view.getByText("新增技能的设置")).toBeInTheDocument();
    expect(view.getByText("升级后专家用新版本")).toBeInTheDocument();
    expect(view.getByRole("checkbox", { name: /^c/ })).toBeDisabled();
    expect(view.getByRole("button", { name: "导入 2 个" })).toBeEnabled();
    fireEvent.click(view.getByRole("checkbox", { name: /^b/ }));
    expect(view.getByRole("button", { name: "导入" })).toBeEnabled();
    fireEvent.click(view.getByRole("checkbox", { name: /^b/ }));
    fireEvent.click(view.getByRole("button", { name: "导入 2 个" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect((api.save as ReturnType<typeof vi.fn>).mock.calls[0]![0].roots.sort()).toEqual(["a", "b"]);
    expect(await view.findByText("重复（未改动） 1 个")).toBeInTheDocument();
    expect(onImported).not.toHaveBeenCalled();
  });

  it("ClawHub：同名候选点作者后重新检查；扫描有风险只提示不拦", async () => {
    const api: SkillImportApi = {
      preview: vi.fn()
        .mockResolvedValueOnce({ origin: ORIGIN, clawhub: { candidates: [{ owner: "alice", slug: "weather", url: "https://clawhub.ai/alice/skills/weather" }, { owner: "bob", slug: "weather", url: "https://clawhub.ai/bob/skills/weather" }] } })
        .mockResolvedValueOnce({ origin: ORIGIN, preview: item({ name: "weather" }), clawhub: { security: { status: "suspicious", has_warnings: true, scanners: [{ name: "skillspector", status: "suspicious" }, { name: "virustotal", status: "clean" }, { name: "custom", status: "odd" }] } } }),
      save: vi.fn(),
    };
    render(<SkillImportDialog api={api} onClose={vi.fn()} onImported={vi.fn()} initial={{ source: "clawhub", url: "weather" }} />);
    const view = within(screen.getByRole("dialog", { name: "导入技能" }));
    fireEvent.keyDown(view.getByRole("textbox", { name: "ClawHub 地址" }), { key: "Enter" });
    const list = within(await view.findByLabelText("同名技能候选"));
    expect(list.getByText("ClawHub 上有 2 个同名技能，选择作者：")).toBeInTheDocument();
    fireEvent.click(list.getByRole("button", { name: "bob/weather" }));
    await waitFor(() => expect(api.preview).toHaveBeenLastCalledWith({ source: "clawhub", url: "https://clawhub.ai/bob/skills/weather" }));
    const scan = within(await view.findByLabelText("ClawHub 安全扫描"));
    expect(scan.getByText("静态扫描：有可疑项")).toBeInTheDocument();
    expect(scan.getByText("病毒扫描：未发现风险")).toBeInTheDocument();
    expect(scan.getByText("custom：结论未知")).toBeInTheDocument();
    expect(scan.getByText("扫描提示有风险，仅供参考")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "导入" })).toBeEnabled();
  });

  it("ClawHub 没有扫描结论时如实说明", async () => {
    const { view } = setup({ origin: ORIGIN, preview: item(), clawhub: { security: null } }, null, { initial: { source: "clawhub", url: "https://clawhub.ai/a/skills/b" } });
    fireEvent.click(view.getByRole("button", { name: "检查" }));
    expect(await view.findByText("未取得扫描结论")).toBeInTheDocument();
  });

  it("错误提示：超限、下载失败、普通错误、空结果、导入失败", async () => {
    const cases: [Error | null, string][] = [
      [new ApiError("too big", 413, "payload_too_large"), "技能太大，超过上限（最多 256 个文件、共 10 MiB）。"],
      [new ApiError("GitHub 返回 404", 502, "download_failed"), "GitHub 返回 404。请检查网址或稍后再试。"],
      [new ApiError("", 502, "download_failed"), "下载失败。请检查网址或稍后再试。"],
      [new Error(""), "检查失败，请重试"],
      [null, "没有拿到检查结果"],
    ];
    for (const [failure, message] of cases) {
      const { view } = setup(failure, null, { sources: ["url"] });
      fireEvent.change(view.getByRole("textbox", { name: "网址" }), { target: { value: "https://example.com/skill" } });
      fireEvent.click(view.getByRole("button", { name: "检查" }));
      expect(await view.findByText(message)).toBeInTheDocument();
      document.body.innerHTML = "";
    }
    const { view } = setup({ origin: ORIGIN, preview: item() }, new Error("写库失败"), { sources: ["text"] });
    fireEvent.change(view.getByRole("textbox", { name: "SKILL.md 内容" }), { target: { value: "x" } });
    fireEvent.click(view.getByRole("button", { name: "检查" }));
    fireEvent.click(await view.findByRole("button", { name: "导入" }));
    expect(await view.findByText("写库失败")).toBeInTheDocument();
  });

  it("zip / 单个 .md：选了文件才能检查；改来源清掉上次结果", async () => {
    const { api, view } = setup({ origin: ORIGIN, preview: item({ existing: "same" }) });
    tab("zip");
    expect(view.getByText("选一个技能压缩包（.zip）。")).toBeInTheDocument();
    const zip = new File(["PK"], "skill.zip", { type: "application/zip" });
    fireEvent.change(view.getByLabelText("技能压缩包", { selector: "input" }), { target: { files: [zip] } });
    fireEvent.click(view.getByRole("button", { name: "检查" }));
    await waitFor(() => expect(api.preview).toHaveBeenCalledWith({ source: "zip", files: [{ file: zip, path: "skill.zip" }] }));
    expect(await view.findByText("目录里已有，内容相同")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "导入" })).toBeDisabled();
    tab("file");
    expect(view.queryByText("目录里已有，内容相同")).toBeNull();
    const md = new File(["---\nname: a\n---"], "SKILL.md", { type: "text/markdown" });
    fireEvent.change(view.getByLabelText("SKILL.md 文件", { selector: "input" }), { target: { files: [md] } });
    fireEvent.click(view.getByRole("button", { name: "检查" }));
    await waitFor(() => expect(api.preview).toHaveBeenLastCalledWith({ source: "file", files: [{ file: md, path: "SKILL.md" }] }));
    fireEvent.click(view.getByRole("button", { name: "取消" }));
  });
});

describe("SkillImportDialog 检查后内容变化", () => {
  it("网址来源导入时带上检查到的内容哈希；服务端说变了就清掉结果，要求重新检查", async () => {
    const changed = new ApiError("内容在检查之后有变化，请重新检查后再导入", 409, "content_changed");
    const { api, view, onImported } = setup({ origin: ORIGIN, preview: item({ content_hash: "h1" }) }, changed, { sources: ["url"] });
    fireEvent.change(view.getByRole("textbox", { name: "网址" }), { target: { value: "https://example.com/skill" } });
    fireEvent.click(view.getByRole("button", { name: "检查" }));
    fireEvent.click(await view.findByRole("button", { name: "导入" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ source: "url", url: "https://example.com/skill", roots: [""], expected_hashes: { "": "h1" } }));
    expect(await view.findByText(/内容在检查之后有变化/)).toBeInTheDocument();
    expect(view.getByRole("button", { name: "导入" })).toBeDisabled();
    expect(view.queryByText("weekly-report · vabc123")).toBeNull();
    expect(onImported).not.toHaveBeenCalled();
  });

  it("上传的文件就是本机这份，不带哈希", async () => {
    const { api, view } = setup({ origin: ORIGIN, preview: item({ content_hash: "h1" }) }, { origin: ORIGIN, results: [] }, { sources: ["zip"] });
    const zip = new File(["PK"], "skill.zip", { type: "application/zip" });
    fireEvent.change(view.getByLabelText("技能压缩包", { selector: "input" }), { target: { files: [zip] } });
    fireEvent.click(view.getByRole("button", { name: "检查" }));
    fireEvent.click(await view.findByRole("button", { name: "导入" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ source: "zip", files: [{ file: zip, path: "skill.zip" }], roots: [""] }));
  });
});

describe("scannerBadge", () => {
  it("已知扫描器与结论映射成中文；未知的原样显示", () => {
    expect(scannerBadge({ name: "llm", status: "malicious" })).toEqual({ label: "模型复核：判定恶意", variant: "error" });
    expect(scannerBadge({ name: "skillspector", status: "pending" })).toEqual({ label: "静态扫描：扫描中", variant: "neutral" });
    expect(scannerBadge({ name: "other", status: "benign" })).toEqual({ label: "other：未发现风险", variant: "success" });
  });
});
