import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CapabilitiesDialog } from "./CapabilitiesDialog";
import type { PlatformModel } from "./types";

const MODEL: PlatformModel = {
  provider_id: "p1", model_id: "minimax-m3", display_name: "MiniMax M3", capabilities: {}, status: "published",
  source: "discovery", version: 1, updated_at: "2026-01-01T00:00:00Z",
};

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const save = () => fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

describe("CapabilitiesDialog", () => {
  it("最大输出超过上下文窗口时不提交", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CapabilitiesDialog model={MODEL} busy={false} onClose={vi.fn()} onSave={onSave} />);
    type(/^最大输出/, "300000");
    type(/^上下文窗口/, "200000");
    save();
    expect(await screen.findByText("最大输出不能超过上下文窗口")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("提交图片输入与思考档位的上游取值", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CapabilitiesDialog model={MODEL} busy={false} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText("支持图片输入"));
    fireEvent.click(screen.getByRole("switch", { name: "支持思考" }));
    fireEvent.click(screen.getByLabelText("high（高）"));
    type("minimax-m3 high 上游取值", "max");
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      reasoning: true, thinking_mode: "effort", thinking_level_map: { high: "max" }, input: ["text", "image"],
    })));
  });

  it("保存失败时显示原因；取消关闭弹窗", async () => {
    const onClose = vi.fn();
    render(<CapabilitiesDialog model={MODEL} busy={false} onClose={onClose} onSave={vi.fn().mockRejectedValue(new Error("网关不可用"))} />);
    save();
    expect(await screen.findByText("网关不可用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalled();
  });
});
