import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationPermissionControl } from "./ConversationPermissionControl";
import { updateConversation, type Conversation } from "./useChatApi";

vi.mock("./useChatApi", async () => {
  const actual = await vi.importActual<typeof import("./useChatApi")>("./useChatApi");
  return { ...actual, updateConversation: vi.fn() };
});

const mockedUpdate = vi.mocked(updateConversation);

function conversation(permission_mode?: Conversation["permission_mode"]): Conversation {
  return {
    id: "conversation-1",
    title: "测试会话",
    kind: "private",
    state: "active",
    entry_employee_id: "employee-1",
    coordinator_employee_id: null,
    solution_instance_id: null,
    schedule: null,
    permission_mode,
    last_read_entry_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

afterEach(() => vi.clearAllMocks());

describe("ConversationPermissionControl", () => {
  it("defaults legacy conversations to read-only and saves a selected mode", async () => {
    const updated = conversation("workspace-write");
    mockedUpdate.mockResolvedValue(updated);
    const onChanged = vi.fn();
    render(<ConversationPermissionControl client={{} as never} conversation={conversation()} onChanged={onChanged} />);

    expect(screen.getByRole("button", { name: "运行权限：只读" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "运行权限：只读" }));
    expect(screen.getByRole("dialog", { name: "运行权限" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox", { name: "权限档位" }));
    fireEvent.click(screen.getByRole("option", { name: "工作区可写" }));
    fireEvent.click(screen.getByRole("button", { name: "保存权限" }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith({}, "conversation-1", { permission_mode: "workspace-write" }));
    expect(onChanged).toHaveBeenCalledWith(updated);
  });

  it("requires a visible confirmation before saving full access", async () => {
    const updated = conversation("full-access");
    mockedUpdate.mockResolvedValue(updated);
    const onChanged = vi.fn();
    render(<ConversationPermissionControl client={{} as never} conversation={conversation()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "运行权限：只读" }));
    fireEvent.click(screen.getByRole("combobox", { name: "权限档位" }));
    fireEvent.click(screen.getByRole("option", { name: "完全访问" }));
    expect(screen.getByText("完全访问风险")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存权限" }));
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(screen.getByText("请先确认完全访问风险，再保存权限")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "我确认仅在可信任务中启用完全访问" }));
    fireEvent.click(screen.getByRole("button", { name: "保存权限" }));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith({}, "conversation-1", { permission_mode: "full-access" }));
    expect(onChanged).toHaveBeenCalledWith(updated);
  });
});
