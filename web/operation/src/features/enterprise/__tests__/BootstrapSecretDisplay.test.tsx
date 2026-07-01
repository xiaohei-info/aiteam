/**
 * 一次性凭据复制行为测试（修 http 明文访问下复制无反应）：
 * - 安全上下文：走 navigator.clipboard.writeText，成功 → "已复制"。
 * - HTTP 非安全上下文（navigator.clipboard 不可用）：降级 document.execCommand("copy")，成功 → "已复制"。
 * - 两者都失败：提示"复制失败"并显示完整凭据供手动全选。
 */
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createI18n, sharedMessages } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { operationMessages } from "../../../i18n/messages";
import { BootstrapSecretDisplay } from "../BootstrapSecretDisplay";

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", operationMessages["zh-CN"]!);
  return i18n;
}

const SECRET = "GYV-bquvfVix$g6++iaWah8&";

function renderDisplay() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <BootstrapSecretDisplay
        secret={SECRET}
        enterpriseId="ent_1"
        tenantId="t_1"
        ownerPhone="1111111111"
        mustReset
      />
    </I18nContext.Provider>,
  );
}

function setSecureContext(value: boolean) {
  Object.defineProperty(window, "isSecureContext", { value, configurable: true });
}

let execSpy: Mock;

beforeEach(() => {
  // jsdom 无 document.execCommand，直接挂一个可控 mock（默认失败）。
  execSpy = vi.fn().mockReturnValue(false);
  (document as unknown as { execCommand: Mock }).execCommand = execSpy;
});

afterEach(() => {
  vi.restoreAllMocks();
  // 清掉可能被写入的 clipboard mock
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});

describe("BootstrapSecretDisplay 复制", () => {
  it("安全上下文走 clipboard API 成功 → 已复制", async () => {
    setSecureContext(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    renderDisplay();
    fireEvent.click(screen.getByRole("button", { name: "复制凭据" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(execSpy).not.toHaveBeenCalled();
  });

  it("HTTP 非安全上下文降级 execCommand 成功 → 已复制", async () => {
    setSecureContext(false);
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    execSpy.mockReturnValue(true);

    renderDisplay();
    fireEvent.click(screen.getByRole("button", { name: "复制凭据" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument());
    expect(execSpy).toHaveBeenCalledWith("copy");
  });

  it("两者都失败 → 提示复制失败并显示完整凭据", async () => {
    setSecureContext(false);
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    execSpy.mockReturnValue(false);

    renderDisplay();
    // 常态脱敏，看不到完整凭据
    expect(screen.queryByText(SECRET)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "复制凭据" }));

    await waitFor(() =>
      expect(screen.getByText("复制失败，请手动选中下方凭据复制")).toBeInTheDocument(),
    );
    // 失败后显示完整凭据供手动复制
    expect(screen.getByText(SECRET)).toBeInTheDocument();
  });
});
