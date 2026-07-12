import { useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useApp } from "../../lib/app-context";
import { useAccount, useLogout, usePreferences, useResync } from "./useSettingsApi";
import type { SettingsTabId } from "./types";

const tabs: Array<{ id: SettingsTabId; label: string }> = [
  { id: "account", label: "账号" },
  { id: "preferences", label: "偏好" },
  { id: "security", label: "安全" },
];

function formatIso(epochSec: number): string {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toISOString().replace("T", " ").slice(0, 19);
}

export function SettingsPage(): ReactNode {
  const { session, i18n } = useApp();
  const { profile } = useAccount();
  const { preferences, setPreferences } = usePreferences();
  const { logout } = useLogout();
  const resync = useResync();
  const [activeTab, setActiveTab] = useState<SettingsTabId>("account");

  return (
    <VStack gap={4} role="region" aria-label={i18n.t("agent.settings.title")}>
      <VStack gap={1}>
        <Heading level={1}>{i18n.t("agent.settings.title")}</Heading>
        <Text type="supporting">{i18n.t("agent.settings.subtitle")}</Text>
      </VStack>
      <HStack gap={1} role="tablist" aria-label={i18n.t("agent.settings.title")}>
        {tabs.map((tab) => (
          <Button
            key={tab.id}
            label={tab.label}
            role="tab"
            aria-selected={activeTab === tab.id}
            variant={activeTab === tab.id ? "primary" : "secondary"}
            onClick={() => setActiveTab(tab.id)}
          />
        ))}
      </HStack>
      {activeTab === "account" && <AccountTab profile={profile} session={session} />}
      {activeTab === "preferences" && (
        <PreferencesTab preferences={preferences} setPreferences={setPreferences} />
      )}
      {activeTab === "security" && (
        <SecurityTab profile={profile} logout={logout} resync={resync} />
      )}
    </VStack>
  );
}

function AccountTab({ profile, session }: {
  profile: ReturnType<typeof useAccount>["profile"];
  session: ReturnType<typeof useApp>["session"];
}): ReactNode {
  const rows = profile ? [
    ["用户 ID", profile.principal.id],
    ["显示名称", profile.principal.display_name],
    ["租户", profile.principal.tenant_id ?? "—"],
    ["企业", profile.principal.enterprise_id ?? "—"],
    ["状态", profile.principal.status],
    ["角色", profile.principal.roles.join(", ") || "—"],
    ["Token 过期时间", formatIso(profile.tokenExpiresAt)],
  ] : [];
  return (
    <Card padding={4}>
      <VStack gap={3}>
        <Heading level={2}>账号信息</Heading>
        {!profile || !session ? <Text type="supporting">未登录，账号信息不可用</Text> : (
          <dl>{rows.map(([label, value]) => (
            <HStack as="div" key={label} gap={2}><dt>{label}</dt><dd>{value}</dd></HStack>
          ))}</dl>
        )}
      </VStack>
    </Card>
  );
}

function PreferencesTab({ preferences, setPreferences }: {
  preferences: ReturnType<typeof usePreferences>["preferences"];
  setPreferences: ReturnType<typeof usePreferences>["setPreferences"];
}): ReactNode {
  return (
    <Card padding={4}>
      <VStack gap={3}>
        <Heading level={2}>偏好设置</Heading>
        <label htmlFor="settings-locale">语言</label>
        <select
          id="settings-locale"
          value={preferences.locale}
          onChange={(event) => setPreferences({ ...preferences, locale: event.currentTarget.value })}
        >
          <option value="zh-CN">中文（简体）</option>
          <option value="en-US">English</option>
        </select>
        <label>
          <input
            type="checkbox"
            checked={preferences.streamTypingEffect}
            onChange={(event) => setPreferences({ ...preferences, streamTypingEffect: event.currentTarget.checked })}
          />
          流式打字效果
        </label>
        <Text type="supporting">偏好仅保存在本机，不上传控制面。</Text>
      </VStack>
    </Card>
  );
}

function SecurityTab({ profile, logout, resync }: {
  profile: ReturnType<typeof useAccount>["profile"];
  logout: ReturnType<typeof useLogout>["logout"];
  resync: ReturnType<typeof useResync>;
}): ReactNode {
  const tokenStatus = profile && profile.tokenExpiresAt * 1000 > Date.now() ? "Token 有效" : "Token 已过期";
  return (
    <VStack gap={3}>
      <Card padding={4}><VStack gap={2}><Heading level={2}>安全</Heading><Text>{tokenStatus}</Text></VStack></Card>
      <Card padding={4}>
        <VStack gap={2}>
          <Heading level={2}>配置同步</Heading>
          <Text type="supporting">从 Manager 主动拉取当前成员授权配置。</Text>
          <Button label="立即同步" variant="primary" onClick={resync.sync} isLoading={resync.syncing} />
          {resync.result && (
            <Banner
              status={resync.result.ok ? "success" : "error"}
              title={resync.result.ok ? "同步成功" : "同步失败"}
              description={resync.result.ok
                ? `新增 ${resync.result.upserted}，撤销 ${resync.result.revoked}`
                : resync.result.error ?? "未知错误"}
            />
          )}
          {resync.error && <Banner status="error" title="同步失败" description={resync.error} />}
        </VStack>
      </Card>
      <Card padding={4} variant="red">
        <VStack gap={2}>
          <Heading level={2}>危险操作</Heading>
          <Text type="supporting">退出后将清除本机登录态。</Text>
          <Button label="退出登录" variant="destructive" onClick={logout} />
        </VStack>
      </Card>
    </VStack>
  );
}
