/**
 * RequireAuth 守卫测试：未登录跳 /login；已登录放行。
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import { AppProvider } from "../lib/app-context";
import { RequireAuth } from "./RequireAuth";

function Inner() {
  return <div>PROTECTED</div>;
}

describe("RequireAuth", () => {
  it("未登录重定向到 /login", () => {
    window.localStorage.clear();
    render(
      <MemoryRouter initialEntries={["/workspace"]}>
        <AppProvider>
          <Routes>
            <Route path="/login" element={<div>LOGIN</div>} />
            <Route
              path="/workspace"
              element={
                <RequireAuth>
                  <Inner />
                </RequireAuth>
              }
            />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("LOGIN")).toBeInTheDocument();
    expect(screen.queryByText("PROTECTED")).toBeNull();
  });

  it("已登录放行", () => {
    window.localStorage.setItem(
      "aiteam.agent.token",
      "tok",
    );
    window.localStorage.setItem(
      "aiteam.agent.claims",
      JSON.stringify({ user_id: "u", roles: ["member"], exp: 9999999999 }),
    );
    render(
      <MemoryRouter initialEntries={["/workspace"]}>
        <AppProvider>
          <Routes>
            <Route path="/login" element={<div>LOGIN</div>} />
            <Route
              path="/workspace"
              element={
                <RequireAuth>
                  <Inner />
                </RequireAuth>
              }
            />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("PROTECTED")).toBeInTheDocument();
  });
});
