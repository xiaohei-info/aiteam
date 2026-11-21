import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "@aiteam/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillMarketPage } from "./SkillMarketPage";
import { SEARCH_DEBOUNCE_MS } from "./useExternalSkills";

const api = {
  listInternal: vi.fn(), listExternal: vi.fn(), browseExternal: vi.fn(), preview: vi.fn(), resolve: vi.fn(),
  download: vi.fn(), publish: vi.fn(), unpublish: vi.fn(), getSettings: vi.fn(), setSettings: vi.fn(),
  previewCustom: vi.fn(), saveCustom: vi.fn(), files: vi.fn(),
};

vi.mock("./useSkillMarketApi", () => ({ useSkillMarketApi: () => api }));

const external = (slug: string, extra: Record<string, unknown> = {}) => ({
  owner: "pub", slug, display_name: slug, summary: "x", latest_version: null, downloads: 3, canonical_url: `https://clawhub.ai/pub/skills/${slug}`, ...extra,
});

const preview = {
  owner: "pub", slug: "fresh", display_name: "Fresh", summary: "新技能", version: "2.0.0", canonical_url: "https://clawhub.ai/pub/skills/fresh",
  files: [{ path: "SKILL.md", size: 40 }, { path: "scripts/run.sh", size: 20 }], total_bytes: 60,
  skipped: [{ path: "hooks/openclaw/handler.js", reason: "platform_hook" }],
  security: { status: "suspicious", has_warnings: true, scanners: [{ name: "skillspector", status: "suspicious", recommendation: "DO_NOT_INSTALL" }, { name: "llm", status: "clean" }] },
  imported_version: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listInternal.mockResolvedValue([{ skill_id: "s1", owner: "pub", slug: "demo", display_name: "Demo", summary: "x", latest_internal_version: "1.0.0", published_version: "1.0.0", content_hash: "hash", status: "published", security: null }]);
  api.browseExternal.mockResolvedValue({ items: [external("demo", { latest_version: "1.0.0" }), external("fresh")], nextCursor: "c2" });
  api.preview.mockResolvedValue(preview);
  api.download.mockResolvedValue({ skill_id: "s2", version: "2.0.0", content_hash: "h", status: "published", skipped: preview.skipped });
  api.getSettings.mockResolvedValue({ auto_publish_downloads: true });
  api.setSettings.mockResolvedValue({ auto_publish_downloads: false });
});

afterEach(() => vi.useRealTimers());

describe("SkillMarketPage", () => {
  it("展示内部/ClawHub 双市场、默认自动开放和下架操作", async () => {
    render(<SkillMarketPage />);
    await screen.findByText("Demo");
    expect(screen.getByRole("button", { name: "内部技能市场" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ClawHub 外部市场" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /下载后自动开放/ })).toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: /下载后自动开放/ }));
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith(false));
    fireEvent.click(screen.getByRole("button", { name: "下架" }));
    await waitFor(() => expect(api.unpublish).toHaveBeenCalledWith("s1"));
  });

  it("打开页面不请求 ClawHub；ClawHub 故障不影响内部市场，可重试", async () => {
    api.browseExternal.mockRejectedValueOnce(new ApiError("rate", 429, "too_many_requests"));
    render(<SkillMarketPage />);
    await screen.findByText("Demo");
    expect(api.browseExternal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "ClawHub 外部市场" }));
    expect(await screen.findByText(/请求太频繁/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("fresh")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "内部技能市场" }));
    expect(screen.getByText("Demo")).toBeInTheDocument();
  });

  it("搜索结果不带版本时不误报「更新」；版本已知且不同时才提示", async () => {
    api.browseExternal.mockResolvedValue({ items: [external("demo")], nextCursor: null });
    const { unmount } = render(<SkillMarketPage />);
    fireEvent.click(await screen.findByRole("button", { name: "ClawHub 外部市场" }));
    expect(await screen.findByText("已导入 v1.0.0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "预览更新" })).not.toBeInTheDocument();
    unmount();
    api.browseExternal.mockResolvedValue({ items: [external("demo", { latest_version: "1.1.0" })], nextCursor: null });
    render(<SkillMarketPage />);
    fireEvent.click(await screen.findByRole("button", { name: "ClawHub 外部市场" }));
    expect(await screen.findByRole("button", { name: "预览更新" })).toBeInTheDocument();
  });

  it("加载更多按游标追加；搜索停顿后才请求", async () => {
    render(<SkillMarketPage />);
    fireEvent.click(await screen.findByRole("button", { name: "ClawHub 外部市场" }));
    await screen.findByText("fresh");
    api.browseExternal.mockResolvedValueOnce({ items: [external("more")], nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("more")).toBeInTheDocument();
    expect(api.browseExternal).toHaveBeenLastCalledWith(undefined, "c2");
    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();

    vi.useFakeTimers();
    api.browseExternal.mockClear();
    fireEvent.change(screen.getByLabelText(/搜索 ClawHub 技能/), { target: { value: "p" } });
    fireEvent.change(screen.getByLabelText(/搜索 ClawHub 技能/), { target: { value: "pdf" } });
    await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50); });
    expect(api.browseExternal).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(api.browseExternal).toHaveBeenCalledTimes(1);
    expect(api.browseExternal).toHaveBeenCalledWith("pdf");
  });

  it("预览列出导入/跳过文件与两个扫描器结论，有风险也能导入", async () => {
    render(<SkillMarketPage />);
    fireEvent.click(await screen.findByRole("button", { name: "ClawHub 外部市场" }));
    expect(await screen.findByText("已导入")).toBeInTheDocument();
    await screen.findByText("fresh");
    // 按钮顺序：链接导入、demo、fresh。
    fireEvent.click(screen.getAllByRole("button", { name: "预览" }).at(-1)!);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("scripts/run.sh")).toBeInTheDocument();
    expect(within(dialog).getByText("hooks/openclaw/handler.js")).toBeInTheDocument();
    expect(within(dialog).getByText("其他平台专用钩子")).toBeInTheDocument();
    expect(within(dialog).getByText("静态扫描：有可疑项")).toBeInTheDocument();
    expect(within(dialog).getByText("模型复核：未发现风险")).toBeInTheDocument();
    expect(within(dialog).getByText(/扫描提示有风险，仅供参考/)).toBeInTheDocument();
    expect(api.download).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "导入" }));
    await waitFor(() => expect(api.download).toHaveBeenCalledWith("pub", "fresh", "2.0.0"));
    expect(await screen.findByText(/已导入 Fresh v2.0.0（已开放，跳过 1 个文件）/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ClawHub 详情与「在 ClawHub 查看」在新标签页打开，不离开运营端", async () => {
    render(<SkillMarketPage />);
    fireEvent.click(await screen.findByRole("button", { name: "ClawHub 外部市场" }));
    await screen.findByText("fresh");
    const details = screen.getAllByRole("link", { name: "详情" });
    expect(details.length).toBeGreaterThan(0);
    for (const link of details) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    fireEvent.click(screen.getAllByRole("button", { name: "预览" }).at(-1)!);
    const view = await within(await screen.findByRole("dialog")).findByRole("link", { name: "在 ClawHub 查看" });
    expect(view).toHaveAttribute("href", "https://clawhub.ai/pub/skills/fresh");
    expect(view).toHaveAttribute("target", "_blank");
  });

  it("导入失败时弹窗保留并显示原因", async () => {
    api.download.mockRejectedValueOnce(new ApiError("下载的文件与 ClawHub 校验清单不一致：SKILL.md", 422, "validation_error"));
    render(<SkillMarketPage />);
    fireEvent.click(await screen.findByRole("button", { name: "ClawHub 外部市场" }));
    await screen.findByText("fresh");
    fireEvent.click(screen.getAllByRole("button", { name: "预览" }).at(-1)!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "导入" }));
    expect(await within(dialog).findByText(/校验清单不一致/)).toBeInTheDocument();
  });

  it("链接未写作者时列出同名候选", async () => {
    api.resolve.mockResolvedValue({ slug: "fresh", owner: null, candidates: [{ owner: "pub", slug: "fresh", url: "" }, { owner: "other", slug: "fresh", url: "" }] });
    render(<SkillMarketPage />);
    fireEvent.click(await screen.findByRole("button", { name: "ClawHub 外部市场" }));
    fireEvent.change(screen.getByLabelText(/按链接导入/), { target: { value: "https://clawhub.ai/skills/fresh" } });
    fireEvent.click(screen.getAllByRole("button", { name: "预览" })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "other/fresh" }));
    await waitFor(() => expect(api.preview).toHaveBeenCalledWith("other", "fresh"));
  });
});

describe("自建技能", () => {
  const custom = { skill_id: "s3", source: "custom", owner: "platform", slug: "weekly-report", display_name: "weekly-report", summary: "生成周报", latest_internal_version: "1.0.0", published_version: "1.0.0", content_hash: "h3", status: "published", security: null, namespace: "taiyim", provenance: null };
  const hubProvenance = { kind: "clawhub", label: "ClawHub pub/demo", url: "https://clawhub.ai/pub/skills/demo", version: "", edited: false };
  const SKILL = "---\nname: weekly-report\ndescription: 生成周报。写周报时使用。\n---\n# 周报\n";

  beforeEach(() => {
    api.listInternal.mockResolvedValue([{ skill_id: "s1", source: "clawhub", owner: "pub", slug: "demo", display_name: "Demo", summary: "x", latest_internal_version: "1.0.0", published_version: "1.0.0", content_hash: "hash", status: "published", security: null, namespace: "", provenance: hubProvenance }, custom]);
    api.saveCustom.mockResolvedValue({ origin: { kind: "editor", label: "在线编辑" }, results: [{ root: "", name: "meeting-notes", version: "abc123", status: "installed" }], auto_publish: true });
    api.files.mockImplementation(async (id: string) => ({ skill_id: id, source: id === "s3" ? "custom" : "clawhub", display_name: "x", summary: "", version: "1.0.0", files: [{ path: "SKILL.md", content: SKILL }, { path: "scripts/run.sh", content: "echo\n" }] }));
  });

  async function openMenu(item: string) {
    await screen.findByText("Demo");
    fireEvent.click(screen.getByRole("button", { name: "新增自定义技能" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: item }));
  }

  it("卡片标题带命名空间；ClawHub 技能注明出处（新标签页），自建技能不带扫描徽章", async () => {
    render(<SkillMarketPage />);
    expect(await screen.findByRole("heading", { name: "taiyim/weekly-report" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Demo" })).toBeInTheDocument();
    expect(screen.getByText("平台自建 · v1.0.0")).toBeInTheDocument();
    expect(screen.getByText("ClawHub 导入 · v1.0.0")).toBeInTheDocument();
    const origin = screen.getByRole("link", { name: /ClawHub pub\/demo/ });
    expect(origin).toHaveAttribute("href", "https://clawhub.ai/pub/skills/demo");
    expect(origin).toHaveAttribute("target", "_blank");
    expect(screen.getAllByText("未取得扫描结论")).toHaveLength(1);  // 只有 ClawHub 技能有扫描结论一说
    expect(screen.getAllByRole("button", { name: "编辑" })).toHaveLength(2);
  });

  it("编辑 ClawHub 技能：另存为平台副本（fork_of），原件保留；不改内容不能保存", async () => {
    api.saveCustom.mockResolvedValue({ origin: { kind: "editor", label: "在线编辑" }, results: [{ root: "", name: "weekly-report", version: "9e1", status: "installed" }], auto_publish: true });
    api.files.mockImplementation(async (id: string) => ({ skill_id: id, source: "clawhub", display_name: "Demo", summary: "", version: "1.0.0", files: [{ path: "SKILL.md", content: SKILL.replace("weekly-report", "demo") }] }));
    render(<SkillMarketPage />);
    await screen.findByRole("heading", { name: "Demo" });
    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
    const dialog = within(await screen.findByRole("dialog", { name: "编辑技能 Demo" }));
    expect(api.files).toHaveBeenCalledWith("s1");
    expect(dialog.getByText(/保存后生成平台副本.*ClawHub 原件保留/)).toBeInTheDocument();
    expect(dialog.getByRole("textbox", { name: /^名称/ })).not.toBeDisabled();
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    expect(await dialog.findByText(/还没有改动/)).toBeInTheDocument();
    expect(api.saveCustom).not.toHaveBeenCalled();
    fireEvent.change(dialog.getByRole("textbox", { name: "指令" }), { target: { value: "# 我们改过\n" } });
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.saveCustom).toHaveBeenCalledTimes(1));
    expect(api.saveCustom.mock.calls[0]![1]).toBe("s1");
    expect(await screen.findByText("已保存 taiyim/demo v9e1（已开放给企业）；ClawHub 原件保留")).toBeInTheDocument();
  });

  it("编辑 ClawHub 技能时名称与已有自建技能相同会提示", async () => {
    api.files.mockImplementation(async (id: string) => ({ skill_id: id, source: "clawhub", display_name: "Demo", summary: "", version: "1.0.0", files: [{ path: "SKILL.md", content: SKILL }] }));
    render(<SkillMarketPage />);
    await screen.findByRole("heading", { name: "Demo" });
    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
    const dialog = within(await screen.findByRole("dialog", { name: "编辑技能 Demo" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "指令" }), { target: { value: "# 改\n" } });
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    expect(await dialog.findByText(/平台里已有自建技能「taiyim\/weekly-report」/)).toBeInTheDocument();
    expect(api.saveCustom).not.toHaveBeenCalled();
  });

  it("从零写一个：按 SKILL.md 填写，保存为在线编辑来源；与已有自建技能重名时提示", async () => {
    render(<SkillMarketPage />);
    await openMenu("从零写一个");
    const dialog = within(await screen.findByRole("dialog", { name: "从零写一个技能" }));
    fireEvent.change(dialog.getByRole("textbox", { name: /^名称/ }), { target: { value: "weekly-report" } });
    fireEvent.change(dialog.getByRole("textbox", { name: /^说明/ }), { target: { value: "整理会议纪要。开完会时使用。" } });
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    expect(await dialog.findByText(/平台里已有自建技能「taiyim\/weekly-report」/)).toBeInTheDocument();
    expect(api.saveCustom).not.toHaveBeenCalled();
    fireEvent.change(dialog.getByRole("textbox", { name: /^名称/ }), { target: { value: "meeting-notes" } });
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.saveCustom).toHaveBeenCalledTimes(1));
    const input = api.saveCustom.mock.calls[0]![0];
    expect(input.source).toBe("editor");
    expect(input.files.map((item: { path: string }) => item.path)).toEqual(["SKILL.md"]);
    expect(await screen.findByText("已保存 taiyim/meeting-notes vabc123（已开放给企业）")).toBeInTheDocument();
    expect(api.listInternal).toHaveBeenCalledTimes(2);
  });

  it("编辑自建技能：取当前版本文件、名称锁定，附带文件照带，存为新版本", async () => {
    api.saveCustom.mockResolvedValue({ origin: { kind: "editor", label: "在线编辑" }, results: [{ root: "", name: "weekly-report", version: "1.0.0-aaaa", status: "updated" }], auto_publish: false });
    render(<SkillMarketPage />);
    await screen.findByRole("heading", { name: "taiyim/weekly-report" });
    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[1]!);
    const dialog = within(await screen.findByRole("dialog", { name: "编辑技能 taiyim/weekly-report" }));
    expect(api.files).toHaveBeenCalledWith("s3");
    expect(dialog.getByRole("textbox", { name: /^名称/ })).toBeDisabled();
    fireEvent.change(dialog.getByRole("textbox", { name: "指令" }), { target: { value: "# 周报 v2\n" } });
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.saveCustom).toHaveBeenCalledTimes(1));
    expect(api.saveCustom.mock.calls[0]![0].files.map((item: { path: string }) => item.path)).toEqual(["SKILL.md", "scripts/run.sh"]);
    expect(await screen.findByText("已保存 taiyim/weekly-report v1.0.0-aaaa（待开放）")).toBeInTheDocument();
  });

  it("导入技能：没有 ClawHub 来源（它在外部市场）；检查与保存走自建接口", async () => {
    api.previewCustom.mockResolvedValue({ origin: { kind: "text", label: "粘贴" }, preview: { root: "", ok: true, name: "weekly-report", description: "生成周报", version: "1.0.1", file_count: 1, total_bytes: 60, files: [{ path: "SKILL.md", size: 60 }], skipped: [], existing: "update", existing_version: "1.0.0" } });
    api.saveCustom.mockResolvedValue({ origin: { kind: "text", label: "粘贴" }, results: [{ root: "", name: "weekly-report", version: "1.0.1", status: "updated" }], auto_publish: true });
    render(<SkillMarketPage />);
    await openMenu("导入技能");
    const dialog = within(await screen.findByRole("dialog", { name: "导入技能" }));
    expect(dialog.queryByRole("button", { name: "ClawHub" })).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "粘贴 SKILL.md" }));
    fireEvent.change(dialog.getByLabelText(/SKILL.md 内容/), { target: { value: SKILL } });
    fireEvent.click(dialog.getByRole("button", { name: "检查" }));
    expect(await dialog.findByText("将升级 v1.0.0 → v1.0.1")).toBeInTheDocument();
    expect(dialog.getByText(/会成为它的新版本/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "导入" }));
    await waitFor(() => expect(api.saveCustom).toHaveBeenCalledWith(expect.objectContaining({ source: "text", roots: [""] })));
    expect(await dialog.findByText("已升级新版本 1 个")).toBeInTheDocument();
  });
});
