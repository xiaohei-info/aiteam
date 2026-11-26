import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError, type AuthSession } from "@aiteam/shared";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { EmployeeAvatarEditor, avatarFileProblem, isEmployeeAvatar } from "../EmployeeAvatar";
import type { EmployeeConfig } from "../types";

const session = {
  principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles: ["owner"] },
  claims: { user_id: "u1", tenant_id: "t1", roles: ["owner"], exp: Math.floor(Date.now() / 1000) + 3600 },
} as AuthSession;
const sessionValue: SessionContextValue = { session, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };

const base: EmployeeConfig = {
  employee_id: "emp-1", employee_slug: "hr", version: 1, display_name: "招聘专员", persona: "p",
  model_policy: { model: "", provider_ref: null, thinking_level: null }, execution_policy: { timeout_seconds: null },
  tools: [], skills: [], knowledge_refs: [], connector_refs: [], memory_policy: null, status: "draft",
};

function renderEditor(employee: EmployeeConfig, upload = vi.fn(), onUploaded = vi.fn()) {
  render(
    <SessionContext.Provider value={sessionValue}>
      <EmployeeAvatarEditor employee={employee} upload={upload} onUploaded={onUploaded} />
    </SessionContext.Provider>,
  );
  return { upload, onUploaded };
}

function pick(file: File) {
  fireEvent.change(screen.getByTestId("employee-avatar-input"), { target: { files: [file] } });
}

describe("EmployeeAvatar", () => {
  it("only treats manager employee avatar content paths as protected", () => {
    expect(isEmployeeAvatar("/api/manager/employees/emp-1/avatar/content?v=2")).toBe(true);
    expect(isEmployeeAvatar("/api/manager/employees/emp-1/avatar/content")).toBe(true);
    expect(isEmployeeAvatar("https://evil.example/api/manager/employees/x/avatar/content")).toBe(false);
    expect(isEmployeeAvatar("data:image/png;base64,AAAA")).toBe(false);
  });

  it("validates type and size before uploading", () => {
    expect(avatarFileProblem({ type: "image/svg+xml", size: 10 })).toMatch("只支持");
    expect(avatarFileProblem({ type: "image/png", size: 0 })).toMatch("空文件");
    expect(avatarFileProblem({ type: "image/png", size: 5 * 1024 * 1024 + 1 })).toMatch("5 MB");
    expect(avatarFileProblem({ type: "image/gif", size: 10 })).toBeNull();
  });

  it("template-origin employees cannot change their avatar", () => {
    renderEditor({ ...base, origin: "recruited" });
    expect(screen.queryByRole("button", { name: /头像/ })).toBeNull();
    expect(screen.getByText("头像随人才市场模板，不能单独更换。")).toBeTruthy();
  });

  it("custom employees upload base64 without data-url prefix and report the new url", async () => {
    const upload = vi.fn().mockResolvedValue({
      employee_id: "emp-1", avatar_url: "/api/manager/employees/emp-1/avatar/content?v=1", version: 1, updated_at: "",
    });
    const { onUploaded } = renderEditor({ ...base, origin: "custom" }, upload);
    expect(screen.getByRole("button", { name: "上传头像" })).toBeTruthy();
    pick(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "a.png", { type: "image/png" }));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith("emp-1", "/api/manager/employees/emp-1/avatar/content?v=1"));
    const [id, body] = upload.mock.calls[0]!;
    expect(id).toBe("emp-1");
    expect(body.mime_type).toBe("image/png");
    expect(body.data).toBe("iVBORw==");
    expect(body.filename).toBe("a.png");
  });

  it("rejects unsupported files locally and surfaces server errors", async () => {
    const upload = vi.fn().mockRejectedValue(new ApiError("图片无法识别", 422, "invalid_avatar"));
    renderEditor({ ...base, origin: "custom" }, upload);
    pick(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }));
    expect(await screen.findByText("只支持 PNG、JPEG、WebP 或 GIF 图片")).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
    pick(new File([new Uint8Array([1, 2, 3])], "b.png", { type: "image/png" }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("图片无法识别")).toBeTruthy();
  });
});
