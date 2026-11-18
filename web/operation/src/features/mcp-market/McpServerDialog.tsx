import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, parseMcpConfig, type McpConfigCandidate } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import type { McpAuth, McpProbeInput, McpProbeResult, PlatformMcpServer, PlatformMcpServerInput } from "./types";

export const AUTH_LABEL: Record<McpAuth, string> = {
  none: "无需鉴权",
  oauth: "成员浏览器登录",
  bearer: "成员访问令牌",
};

const AUTH_OPTIONS = [
  { value: "none", label: "无需鉴权" },
  { value: "oauth", label: "成员在服务方网页登录（OAuth）" },
  { value: "bearer", label: "成员填写服务方发的访问令牌" },
];

type SecretMode = "keep" | "replace" | "clear";

interface Props {
  item: PlatformMcpServer | null;
  busy: boolean;
  onClose: () => void;
  onSave: (input: PlatformMcpServerInput) => Promise<void>;
  probe: (input: McpProbeInput) => Promise<McpProbeResult | null>;
}

/**
 * 登记 / 编辑平台 MCP（设计 2026-11-18 §3.8–§3.11）：顶部可粘贴配置导入；「读取工具」连一次服务判断鉴权方式与工具；
 * 需要鉴权时成员各自登录或填令牌，平台只记鉴权方式。服务方发的应用密钥只写不读。
 */
export function McpServerDialog({ item, busy, onClose, onSave, probe }: Props): ReactNode {
  const [config, setConfig] = useState("");
  const [importNote, setImportNote] = useState<{ status: "info" | "warning" | "error"; text: string } | null>(null);
  const [choices, setChoices] = useState<McpConfigCandidate[]>([]);
  const [ref, setRef] = useState(item?.ref ?? "");
  const [displayName, setDisplayName] = useState(item?.display_name ?? "");
  const [summary, setSummary] = useState(item?.summary ?? "");
  const [url, setUrl] = useState(item?.url ?? "");
  const [tools, setTools] = useState(item?.tools.join("\n") ?? "");
  const [auth, setAuth] = useState<McpAuth>(item?.auth ?? "none");
  const [authHeader, setAuthHeader] = useState(item?.auth_header ?? "");
  const [scopes, setScopes] = useState(item?.oauth_scopes ?? "");
  const [timeoutMs, setTimeoutMs] = useState<number | null>(item?.timeout_ms ?? 30000);
  const [clientId, setClientId] = useState(item?.oauth_client_id ?? "");
  const [secretMode, setSecretMode] = useState<SecretMode>(item?.oauth_client_secret_set ? "keep" : "replace");
  const [secret, setSecret] = useState("");
  const [testToken, setTestToken] = useState("");
  const [probing, setProbing] = useState(false);
  const [probed, setProbed] = useState<McpProbeResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const submitForm = () => formRef.current?.requestSubmit();
  const close = (open: boolean) => { if (!open && !busy) onClose(); };
  const disabled = busy || probing;

  function apply(server: McpConfigCandidate) {
    if (!item) setRef(server.ref);
    if (!displayName.trim()) setDisplayName(server.name || server.ref);
    setUrl(server.url);
    if (server.timeout_ms) setTimeoutMs(server.timeout_ms);
    if (server.auth === "bearer") { setAuth("bearer"); setAuthHeader(server.auth_header ?? ""); }
    setChoices([]);
    const notes = [
      server.refAdjusted ? `名称「${server.name}」不符合标识规则，已改为 ${server.ref}。` : "",
      server.droppedSecret ? "配置里的令牌不会保存到平台，成员安装时自行填写。" : "",
      server.ignoredHeaders.length ? `请求头 ${server.ignoredHeaders.join("、")} 未带入。` : "",
      "已填入下方，可点「读取工具」确认鉴权方式。",
    ].filter(Boolean);
    setImportNote({ status: server.droppedSecret || server.refAdjusted ? "warning" : "info", text: notes.join(" ") });
  }

  function importConfig() {
    const result = parseMcpConfig(config);
    setChoices([]);
    if (!result.ok) { setImportNote({ status: "error", text: result.error }); return; }
    // 粘贴原文可能带令牌；解析出的候选项不含令牌值，原文不再留在窗口里。
    setConfig("");
    const rejected = result.rejected.map((entry) => `${entry.name}：${entry.reason}`).join("；");
    if (!result.servers.length) { setImportNote({ status: "error", text: rejected || "配置里没有可用的 MCP" }); return; }
    if (result.servers.length === 1) {
      apply(result.servers[0]!);
      if (rejected) setImportNote((note) => ({ status: "warning", text: `${note?.text ?? ""} 已跳过：${rejected}` }));
      return;
    }
    setChoices(result.servers);
    setImportNote({ status: "info", text: `配置里有 ${result.servers.length} 个 MCP，请选择一个。${rejected ? ` 已跳过：${rejected}` : ""}` });
  }

  async function readTools() {
    setProbing(true);
    setProbeError(null);
    setProbed(null);
    try {
      const result = await probe({
        url: url.trim(), ...(timeoutMs ? { timeout_ms: Math.min(timeoutMs, 300000) } : {}),
        ...(auth === "bearer" ? { auth_header: authHeader.trim() } : {}),
        ...(auth === "bearer" && testToken ? { test_token: testToken } : {}),
      });
      if (!result) throw new Error();
      setProbed(result);
      if (result.status === "ok") {
        if (result.tools.length) setTools(result.tools.join("\n"));
        if (result.auth === "none" && auth !== "bearer") setAuth("none");
        if (!displayName.trim() && result.server_name) setDisplayName(result.server_name);
      } else if (result.status === "needs_oauth") {
        setAuth("oauth");
        if (!scopes.trim() && result.scope) setScopes(result.scope);
      } else if (result.status === "needs_token") {
        setAuth("bearer");
      }
    } catch (err) {
      setProbeError(err instanceof ApiError ? err.message : "读取失败，请稍后再试");
    } finally {
      setTestToken("");
      setProbing(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const input: PlatformMcpServerInput = {
      ref: ref.trim(), display_name: displayName.trim(), summary: summary.trim(), url: url.trim(),
      tools: tools.split(/[\n,，]/).map((name) => name.trim()).filter(Boolean),
      auth, auth_header: auth === "bearer" ? authHeader.trim() : "",
      oauth_scopes: auth === "oauth" ? scopes.trim() : "",
      timeout_ms: timeoutMs ?? 30000,
      oauth_client_id: auth === "oauth" ? clientId.trim() : "",
    };
    if (auth === "oauth" && clientId.trim()) {
      if (secretMode === "clear") input.oauth_client_secret = "";
      else if (secretMode === "replace" && secret) input.oauth_client_secret = secret;
    }
    void onSave(input);
  }

  const probeBanner = probed && (
    probed.status === "ok" ? <Banner status="success" title={`已读到 ${probed.tools.length} 个工具${probed.server_name ? `（${probed.server_name}）` : ""}`} description={probed.detail || undefined} />
      : probed.status === "needs_oauth" ? <Banner status="info" title={`需要成员在 ${probed.auth_host} 登录`} description={`${probed.detail}${probed.dynamic_registration ? "" : " 该服务不支持自动注册应用，请在「高级」填写服务方发的应用编号。"}`} />
        : probed.status === "needs_token" ? <Banner status="warning" title={probed.token_rejected ? "测试令牌被拒绝" : "需要访问令牌"} description={probed.detail} />
          : <Banner status="error" title="无法连接" description={probed.detail} />
  );

  // 标题与操作按钮固定，中间内容滚动；按钮在表单外，用 requestSubmit 保留表单原生校验。
  return (
    <Dialog isOpen purpose="form" width={640} aria-label={item ? "编辑 MCP" : "登记 MCP"} onOpenChange={close}>
      <Layout
        header={<DialogHeader title={item ? `编辑 ${item.display_name}` : "登记 MCP"} onOpenChange={close} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              <Collapsible defaultIsOpen={!item} trigger={<Text weight="semibold">从配置导入</Text>}>
                <VStack gap={2}>
                  <TextArea
                    label="粘贴配置"
                    description="支持 Claude / Cursor 的 mcpServers 配置、单条配置或 https 链接；只支持 streamable HTTP。配置里的令牌不会保存。"
                    value={config} onChange={setConfig} rows={4} isOptional isDisabled={disabled}
                    placeholder={'"cr-test": {\n  "type": "streamableHttp",\n  "url": "https://…",\n  "timeout": 30000\n}'}
                  />
                  <HStack gap={2}>
                    <Button label="解析并填入" size="sm" onClick={importConfig} isDisabled={disabled || !config.trim()} />
                  </HStack>
                  {importNote && <Banner status={importNote.status} title={importNote.text} />}
                  {choices.length > 0 && (
                    <HStack gap={2} wrap="wrap">
                      {choices.map((choice) => <Button key={`${choice.ref}-${choice.url}`} size="sm" variant="ghost" label={`${choice.name || choice.ref} · ${choice.url}`} onClick={() => apply(choice)} />)}
                    </HStack>
                  )}
                </VStack>
              </Collapsible>
              <form ref={formRef} onSubmit={submit} aria-label="MCP 信息">
                <VStack gap={3}>
                  <TextInput label="标识" description="小写字母开头，只含小写字母、数字、- 或 _；成员本机安装时使用，创建后不能修改。" value={ref} onChange={setRef} isRequired isDisabled={Boolean(item) || disabled} />
                  <TextInput label="名称" value={displayName} onChange={setDisplayName} isRequired isDisabled={disabled} />
                  <TextArea label="用途" value={summary} onChange={setSummary} rows={2} maxLength={500} isOptional isDisabled={disabled} />
                  <TextInput label="端点地址" description="streamable HTTP，仅 https，不能包含账号、查询串。" value={url} onChange={setUrl} isRequired isDisabled={disabled} />
                  <Selector label="鉴权方式" description="需要鉴权时，成员安装时用自己的账号登录或填自己的令牌；平台与企业都不保存成员令牌。" options={AUTH_OPTIONS} value={auth} onChange={(value) => setAuth(value as McpAuth)} isDisabled={disabled} />
                  {auth === "bearer" && (
                    <>
                      <TextInput label="令牌请求头" description="留空表示 Authorization: Bearer <令牌>；填写如 X-API-Key 则直接放在该请求头。" value={authHeader} onChange={setAuthHeader} isOptional isDisabled={disabled} />
                      <TextInput label="测试令牌" type="password" description="只用于这次「读取工具」，不保存、不记录。" value={testToken} onChange={setTestToken} isOptional isDisabled={disabled} />
                    </>
                  )}
                  <HStack gap={2} align="center" wrap="wrap">
                    <Button label="读取工具" size="sm" onClick={() => void readTools()} isLoading={probing} isDisabled={busy || !url.trim()} />
                    <Text type="supporting">连接一次服务，判断鉴权方式并填入工具名。</Text>
                  </HStack>
                  {probeBanner}
                  {probeError && <Banner status="error" title={probeError} />}
                  <TextArea
                    label="工具名"
                    description={auth === "oauth" ? "每行一个。可留空：以成员登录后服务实际提供的工具为准。" : "每行一个。成员安装时只保留与服务端实际工具的交集。"}
                    value={tools} onChange={setTools} rows={4} isRequired={auth !== "oauth"} isOptional={auth === "oauth"} isDisabled={disabled}
                  />
                  <NumberInput label="调用超时（毫秒）" description="单次工具调用最长等待，1000–300000。" value={timeoutMs} onChange={setTimeoutMs} min={1000} max={300000} step={1000} isRequired isDisabled={disabled} />
                  {auth === "oauth" && (
                    <Collapsible defaultIsOpen={Boolean(item?.oauth_client_id || item?.oauth_scopes)} trigger={<Text weight="semibold">高级 · 权限范围与应用编号</Text>}>
                      <VStack gap={3}>
                        <TextInput label="权限范围" description="空格分隔，如 openid profile.read；留空按服务方要求。" value={scopes} onChange={setScopes} isOptional isDisabled={disabled} />
                        <TextInput label="应用编号（client_id）" description="留空：成员登录时以「AI Team」自动注册。服务方不支持自动注册时，填写在服务方开发者后台申请的编号。" value={clientId} onChange={setClientId} isOptional isDisabled={disabled} />
                        {clientId.trim() && (item?.oauth_client_secret_set && secretMode !== "replace" ? (
                          <HStack gap={2} align="center" wrap="wrap">
                            <Text>{secretMode === "clear" ? "应用密钥将在保存时清除" : "应用密钥：已设置（不显示）"}</Text>
                            <Button label="替换" size="sm" variant="ghost" onClick={() => setSecretMode("replace")} isDisabled={disabled} />
                            {secretMode === "keep"
                              ? <Button label="清除" size="sm" variant="ghost" onClick={() => setSecretMode("clear")} isDisabled={disabled} />
                              : <Button label="撤销清除" size="sm" variant="ghost" onClick={() => setSecretMode("keep")} isDisabled={disabled} />}
                          </HStack>
                        ) : (
                          <TextInput label="应用密钥（client_secret）" type="password" description={item?.oauth_client_secret_set ? "输入新密钥替换；留空保持原密钥。" : "服务方未发密钥可留空。加密保存，保存后不再显示。"} value={secret} onChange={setSecret} isOptional isDisabled={disabled} />
                        ))}
                        {item?.oauth_client_secret_set && secretMode === "replace" && <Button label="不替换" size="sm" variant="ghost" onClick={() => { setSecret(""); setSecretMode("keep"); }} isDisabled={disabled} />}
                      </VStack>
                    </Collapsible>
                  )}
                </VStack>
              </form>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack justify="end" gap={2}>
              <Button label="取消" onClick={onClose} isDisabled={busy} />
              <Button label={item ? "保存" : "登记"} variant="primary" isLoading={busy} isDisabled={probing} onClick={submitForm} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
