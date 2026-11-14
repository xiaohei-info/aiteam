import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScopeDialog } from "./ScopeDialog";
import { scopeNarrowed, scopeText } from "./types";

vi.mock("./useCatalogApi", () => ({
  useCatalogApi: () => ({
    scopeOptions: () => Promise.resolve({ industries: ["金融"], tags: ["重点"] }),
    scopePreview: () => Promise.resolve(2),
  }),
}));

afterEach(() => vi.clearAllMocks());

const all = { mode: "all" as const, industries: [], tags: [] };
const limited = (industries: string[], tags: string[] = []) => ({ mode: "limited" as const, industries, tags });
const none = { mode: "none" as const, industries: [], tags: [] };

describe("scopeNarrowed", () => {
  it("全部企业改为指定范围、或去掉已有行业 / 标签，算收窄", () => {
    expect(scopeNarrowed(all, limited(["金融"]))).toBe(true);
    expect(scopeNarrowed(limited(["金融", "医疗"]), limited(["金融"]))).toBe(true);
    expect(scopeNarrowed(limited(["金融"], ["重点"]), limited(["金融"]))).toBe(true);
  });

  it("改为暂不开放算收窄；从暂不开放改为任何范围都是放开", () => {
    expect(scopeNarrowed(all, none)).toBe(true);
    expect(scopeNarrowed(limited(["金融"]), none)).toBe(true);
    expect(scopeNarrowed(none, all)).toBe(false);
    expect(scopeNarrowed(none, limited(["金融"]))).toBe(false);
    expect(scopeNarrowed(none, none)).toBe(false);
  });

  it("范围的展示文字", () => {
    expect(scopeText(none)).toBe("暂不开放");
    expect(scopeText({ hidden: true })).toBe("全部企业");
    expect(scopeText(limited(["金融"], ["重点"]))).toBe("指定：金融、重点");
  });

  it("放开或只增加范围不算收窄", () => {
    expect(scopeNarrowed(limited(["金融"]), all)).toBe(false);
    expect(scopeNarrowed(limited(["金融"]), limited(["金融", "医疗"], ["重点"]))).toBe(false);
    expect(scopeNarrowed(all, all)).toBe(false);
  });
});

describe("ScopeDialog 收窄提示", () => {
  const WARNING = /已招募的专家会自动停用/;

  it("调整已发布模板时收窄范围，提示会自动停用", async () => {
    render(<ScopeDialog title="调整发布范围" confirmLabel="保存范围" initial={all} onConfirm={async () => {}} onClose={() => {}} />);
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("指定行业或标签"));
    expect(await screen.findByText(WARNING)).toBeInTheDocument();
  });

  it("选择暂不开放：说明企业看不到、已招募的专家会停用", async () => {
    let saved: unknown = null;
    render(<ScopeDialog title="调整发布范围" confirmLabel="保存范围" initial={all} onConfirm={async (scope) => { saved = scope; }} onClose={() => {}} />);
    fireEvent.click(screen.getByText("暂不开放"));
    expect(await screen.findByText(/模板保持已发布，但任何企业都看不到/)).toBeInTheDocument();
    expect(await screen.findByText(WARNING)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存范围" }));
    await vi.waitFor(() => expect(saved).toEqual(none));
  });

  it("首次发布没有已招募企业，不提示", async () => {
    render(<ScopeDialog title="发布模板" confirmLabel="确认发布" onConfirm={async () => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText("指定行业或标签"));
    await screen.findByText(/企业的行业命中其中之一/);
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });
});
