/**
 * 设置页（agent）：账号 / 偏好 / 安全 三个 Tab。
 *
 * 设计取舍：
 * - 账号/安全 派生自当前 session 与 useApp，无独立后端端点（whoami 投影足矣）；
 * - 偏好 纯客户端本地状态（localStorage），不上传控制面（本地优先 / D3，§12.2）。
 * - 三 Tab 都是只读或客户端操作；修改密码/资料走「我的资料」入口由 Manager 端完成。
 */

import { useState, type ReactNode } from "react";
import { Button, Field, GlassPanel, Input, Select } from "@aiteam/shared/ui";
import { useApp } from "../../lib/app-context";
import { useAccount, useLogout, usePreferences } from "./useSettingsApi";
import type { SettingsTabId } from "./types";

const tabs: { id: SettingsTabId; labelKey: "agent.settings.tab.account" | "agent.settings.tab.preferences" | "agent.settings.tab.security" }[] = [
  { id: "account", labelKey: "agent.settings.tab.account" },
  { id: "preferences", labelKey: "agent.settings.tab.preferences" },
  { id: "security", labelKey: "agent.settings.tab.security" },
];

function formatIso(epochSec: number): string {
  if (!epochSec) return "—";
  try {
    return new Date(epochSec * 1000).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return String(epochSec);
  }
}

export function SettingsPage(): ReactNode {
  const { session, i18n } = useApp();
  const { profile } = useAccount();
  const { preferences, setPreferences } = usePreferences();
  const { logout } = useLogout();
  const [activeTab, setActiveTab] = useState<SettingsTabId>("account");

  return (
    <section className="flex h-full min-h-0 flex-col gap-lg">
      <header className="flex flex-col gap-xs">
        <h1 className="m-0 text-xl font-bold text-text-primary">{i18n.t("agent.settings.title")}</h1>
        <p className="m-0 text-sm text-text-secondary">{i18n.t("agent.settings.subtitle")}</p>
      </header>

      <div className="flex gap-sm border-b border-gold/10" role="tablist" aria-label={i18n.t("agent.settings.title")}>
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              className={
                "border-b-2 px-sm py-sm text-sm font-medium transition no-underline " +
                (active
                  ? "border-gold text-gold"
                  : "border-transparent text-text-secondary hover:text-text-primary")
              }
            >
              {i18n.t(tab.labelKey)}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {activeTab === "account" ? <AccountTab profile={profile} session={session} i18n={i18n} /> : null}
        {activeTab === "preferences" ? (
          <PreferencesTab preferences={preferences} setPreferences={setPreferences} i18n={i18n} />
        ) : null}
        {activeTab === "security" ? <SecurityTab profile={profile} logout={logout} i18n={i18n} /> : null}
      </div>
    </section>
  );
}

function AccountTab({
  profile,
  session,
  i18n,
}: {
  profile: ReturnType<typeof useAccount>["profile"];
  session: ReturnType<typeof useApp>["session"];
  i18n: ReturnType<typeof useApp>["i18n"];
}): ReactNode {
  const rows: { label: string; value: string }[] = profile
    ? [
        { label: i18n.t("agent.settings.account.user_id"), value: profile.principal.id },
        { label: i18n.t("agent.settings.account.display_name"), value: profile.principal.display_name },
        { label: i18n.t("agent.settings.account.tenant_id"), value: profile.principal.tenant_id ?? "—" },
        { label: i18n.t("agent.settings.account.enterprise_id"), value: profile.principal.enterprise_id ?? "—" },
        { label: i18n.t("agent.settings.account.status"), value: profile.principal.status },
        { label: i18n.t("agent.settings.account.roles"), value: profile.principal.roles.join(", ") || "—" },
        { label: i18n.t("agent.settings.account.token_expires_at"), value: formatIso(profile.tokenExpiresAt) },
      ]
    : [];

  return (
    <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
      <h2 className="m-0 text-base font-semibold text-text-primary">
        {i18n.t("agent.settings.account.title")}
      </h2>
      {!profile || !session ? (
        <p className="m-0 text-sm text-text-secondary">{i18n.t("agent.settings.account.unavailable")}</p>
      ) : (
        <dl className="flex flex-col gap-sm">
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline gap-md">
              <dt className="w-40 shrink-0 text-sm text-text-secondary">{row.label}</dt>
              <dd className="m-0 break-all text-sm text-text-primary">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </GlassPanel>
  );
}

function PreferencesTab({
  preferences,
  setPreferences,
  i18n,
}: {
  preferences: ReturnType<typeof usePreferences>["preferences"];
  setPreferences: ReturnType<typeof usePreferences>["setPreferences"];
  i18n: ReturnType<typeof useApp>["i18n"];
}): ReactNode {
  return (
    <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
      <h2 className="m-0 text-base font-semibold text-text-primary">
        {i18n.t("agent.settings.preferences.title")}
      </h2>
      <Field label={i18n.t("agent.settings.preferences.locale")}>
        <Select
          aria-label={i18n.t("agent.settings.preferences.locale")}
          value={preferences.locale}
          onChange={(e) =>
            setPreferences({ ...preferences, locale: e.currentTarget.value })
          }
        >
          <option value="zh-CN">中文（简体）</option>
          <option value="en-US">English</option>
        </Select>
      </Field>
      <Field label={i18n.t("agent.settings.preferences.stream_typing_effect")}>
        <label className="inline-flex items-center gap-sm text-sm text-text-primary">
          <input
            type="checkbox"
            checked={preferences.streamTypingEffect}
            onChange={(e) =>
              setPreferences({ ...preferences, streamTypingEffect: e.currentTarget.checked })
            }
          />
          <span>{preferences.streamTypingEffect ? i18n.t("common.confirm") : i18n.t("common.cancel")}</span>
        </label>
      </Field>
      <p className="m-0 text-xs text-text-muted">{i18n.t("agent.settings.preferences.local_only_hint")}</p>
    </GlassPanel>
  );
}

function SecurityTab({
  profile,
  logout,
  i18n,
}: {
  profile: ReturnType<typeof useAccount>["profile"];
  logout: ReturnType<typeof useLogout>["logout"];
  i18n: ReturnType<typeof useApp>["i18n"];
}): ReactNode {
  return (
    <div className="flex flex-col gap-md">
      <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
        <h2 className="m-0 text-base font-semibold text-text-primary">
          {i18n.t("agent.settings.security.title")}
        </h2>
        <Field label={i18n.t("agent.settings.security.token_status")}>
          <Input
            readOnly
            value={
              profile && profile.tokenExpiresAt * 1000 > Date.now()
                ? i18n.t("agent.settings.security.token_valid")
                : i18n.t("agent.settings.security.token_expired")
            }
          />
        </Field>
      </GlassPanel>

      <GlassPanel className="flex flex-col gap-md rounded-window border border-danger/30 p-lg">
        <h2 className="m-0 text-base font-semibold text-danger">
          {i18n.t("agent.settings.security.danger_zone")}
        </h2>
        <p className="m-0 text-sm text-text-secondary">
          {i18n.t("agent.settings.security.logout_hint")}
        </p>
        <div>
          <Button type="button" variant="danger" onClick={logout}>
            {i18n.t("agent.settings.security.logout")}
          </Button>
        </div>
      </GlassPanel>
    </div>
  );
}
