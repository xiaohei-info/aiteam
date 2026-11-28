import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProtectedAvatar, type AvatarStreamClient } from "./protected-avatar.js";

const PROTECTED = "/api/manager/employees/e1/avatar/content?v=1";
const isProtected = (src: string) => src.startsWith("/api/manager/employees/");

function streamClient(impl: AvatarStreamClient["stream"]): AvatarStreamClient & { stream: ReturnType<typeof vi.fn> } {
  return { stream: vi.fn(impl) };
}

describe("ProtectedAvatar", () => {
  let created: number;
  const revoked: string[] = [];

  beforeEach(() => {
    created = 0;
    revoked.length = 0;
    // jsdom 不实现 objectURL；先挂占位函数，spyOn 才能替换。
    if (!URL.createObjectURL) URL.createObjectURL = () => "";
    if (!URL.revokeObjectURL) URL.revokeObjectURL = () => undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:avatar-${++created}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => { revoked.push(url); });
  });
  afterEach(() => vi.restoreAllMocks());

  it("fetches protected paths with the client, renders the objectURL and revokes it on change", async () => {
    const client = streamClient(async () => new Response(new Blob(["RIFF"], { type: "image/webp" })));
    const { container, rerender } = render(
      <ProtectedAvatar client={client} isProtected={isProtected} name="Alice" src={PROTECTED} />,
    );
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:avatar-1"));
    expect(client.stream).toHaveBeenCalledWith(PROTECTED, { headers: { Accept: "image/webp" } });

    rerender(<ProtectedAvatar client={client} isProtected={isProtected} name="Alice" src="/api/manager/employees/e1/avatar/content?v=2" />);
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:avatar-2"));
    expect(revoked).toEqual(["blob:avatar-1"]);
    expect(client.stream).toHaveBeenCalledTimes(2);
  });

  it("falls back to the illustration when the fetch fails or no client is available", async () => {
    const failing = streamClient(async () => { throw new Error("offline"); });
    const { container } = render(<ProtectedAvatar client={failing} isProtected={isProtected} name="Bob" src={PROTECTED} />);
    await waitFor(() => expect(failing.stream).toHaveBeenCalled());
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();

    const { container: noClient } = render(<ProtectedAvatar client={null} isProtected={isProtected} name="Bob" src={PROTECTED} />);
    expect(noClient.querySelector("img")).toBeNull();
    expect(created).toBe(0);
  });

  it("passes unprotected sources through without fetching", () => {
    const client = streamClient(async () => new Response(""));
    const { container } = render(<ProtectedAvatar client={client} isProtected={isProtected} name="Carol" src={null} />);
    expect(client.stream).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
  });

  it("ignores a response that arrives after unmount", async () => {
    let release: (value: Response) => void = () => {};
    const client = streamClient(() => new Promise<Response>((resolve) => { release = resolve; }));
    const { unmount } = render(<ProtectedAvatar client={client} isProtected={isProtected} name="Dan" src={PROTECTED} />);
    unmount();
    release(new Response(new Blob(["RIFF"])));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(created).toBe(0);
  });
});
