import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const listGet = vi.fn();
const post = vi.fn();
const put = vi.fn();
vi.mock("../../api/client", () => ({
  createOperationApiClient: vi.fn(() => ({ get, listGet, post, put })),
}));
vi.mock("../../auth/session", () => ({
  useSession: () => ({ token: "tok" }),
}));

import { useSkillMarketApi } from "./useSkillMarketApi";

const B = "/api/operation/skill-market";

describe("useSkillMarketApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue({});
    post.mockResolvedValue({});
    put.mockResolvedValue({});
  });

  it("浏览外部技能：带查询和游标；没有下一页时 nextCursor 为 null；非数组归一化成空", async () => {
    const { result } = renderHook(() => useSkillMarketApi());
    listGet.mockResolvedValueOnce({ items: [{ slug: "a" }], page: { next_cursor: "c2" } });
    await expect(result.current.browseExternal("pdf", "c1")).resolves.toEqual({ items: [{ slug: "a" }], nextCursor: "c2" });
    expect(listGet).toHaveBeenLastCalledWith(`${B}/external`, { query: { q: "pdf", cursor: "c1" } });
    listGet.mockResolvedValueOnce({ items: null });
    await expect(result.current.listExternal()).resolves.toEqual([]);
    expect(listGet).toHaveBeenLastCalledWith(`${B}/external`, { query: undefined });
  });

  it("预览 / 下载编码作者和名字，版本可选；解析 ClawHub 地址", async () => {
    const { result } = renderHook(() => useSkillMarketApi());
    await result.current.preview("a b", "c/d", "1.0.0");
    expect(get).toHaveBeenLastCalledWith(`${B}/external/a%20b/c%2Fd/preview`, { query: { version: "1.0.0" } });
    await result.current.preview("a", "b");
    expect(get).toHaveBeenLastCalledWith(`${B}/external/a/b/preview`, { query: undefined });
    await result.current.resolve("https://clawhub.ai/a/skills/b");
    expect(get).toHaveBeenLastCalledWith(`${B}/external/resolve`, { query: { url: "https://clawhub.ai/a/skills/b" } });
    await result.current.download("a", "b", "2.0.0");
    expect(post).toHaveBeenLastCalledWith(`${B}/external/a/b/download`, { query: { version: "2.0.0" }, body: {} });
    await result.current.download("a", "b");
    expect(post).toHaveBeenLastCalledWith(`${B}/external/a/b/download`, { query: undefined, body: {} });
  });

  it("平台技能：列表、文件、开放 / 下架", async () => {
    const { result } = renderHook(() => useSkillMarketApi());
    listGet.mockResolvedValueOnce({ items: [{ skill_id: "s1" }] });
    await expect(result.current.listInternal()).resolves.toEqual([{ skill_id: "s1" }]);
    listGet.mockResolvedValueOnce({ items: undefined });
    await expect(result.current.listInternal()).resolves.toEqual([]);
    await result.current.files("s 1");
    expect(get).toHaveBeenLastCalledWith(`${B}/internal/s%201/files`);
    await result.current.publish("s1");
    expect(post).toHaveBeenLastCalledWith(`${B}/internal/s1/publish`);
    await result.current.unpublish("s1");
    expect(post).toHaveBeenLastCalledWith(`${B}/internal/s1/unpublish`);
  });

  it("自建技能检查与保存：粘贴走 JSON，上传走 multipart", async () => {
    const { result } = renderHook(() => useSkillMarketApi());
    await result.current.previewCustom({ source: "text", text: "x" });
    expect(post).toHaveBeenLastCalledWith(`${B}/custom/preview`, { body: { source: "text", text: "x" } });
    await result.current.saveCustom({ source: "zip", files: [{ file: new File(["PK"], "s.zip"), path: "s.zip" }] });
    const [url, init] = post.mock.calls.at(-1)!;
    expect(url).toBe(`${B}/custom`);
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("设置：读不到时默认自动开放；保存走 PUT", async () => {
    const { result } = renderHook(() => useSkillMarketApi());
    get.mockResolvedValueOnce(undefined);
    await expect(result.current.getSettings()).resolves.toEqual({ auto_publish_downloads: true });
    get.mockResolvedValueOnce({ auto_publish_downloads: false });
    await expect(result.current.getSettings()).resolves.toEqual({ auto_publish_downloads: false });
    await result.current.setSettings(false);
    expect(put).toHaveBeenLastCalledWith(`${B}/settings`, { body: { auto_publish_downloads: false } });
  });
});
