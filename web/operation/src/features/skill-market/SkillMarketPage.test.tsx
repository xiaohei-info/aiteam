import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "@aiteam/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillMarketPage } from "./SkillMarketPage";
import { SEARCH_DEBOUNCE_MS } from "./useExternalSkills";

const api = {
  listInternal: vi.fn(), listExternal: vi.fn(), browseExternal: vi.fn(), preview: vi.fn(), resolve: vi.fn(),
  download: vi.fn(), publish: vi.fn(), unpublish: vi.fn(), getSettings: vi.fn(), setSettings: vi.fn(),
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
