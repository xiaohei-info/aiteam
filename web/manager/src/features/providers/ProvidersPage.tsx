/**
 * Provider 凭据管理页（W-M.6 M5, AITEAM-681）。
 * 红线（D18）：不展示/缓存明文 secret；只回 provider_ref + 非敏感元数据。
 * 当前 Manager PUT 契约每次都要求新 secret，因此编辑和 rotation 在同一对话框完成。
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Code } from "@astryxdesign/core/CodeBlock";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useProvidersApi } from "./useProvidersApi";
import type {
  CreateProviderInput,
  ProviderApiProtocol,
  ProviderCredential,
  ProviderModelCapability,
  ProviderModelCatalogSource,
  ProviderVisibility,
  UpdateProviderInput,
} from "./types";

const PROTOCOLS: ProviderApiProtocol[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
];
const VISIBILITIES: ProviderVisibility[] = ["tenant", "members"];
const MODEL_CATALOG_SOURCES: ProviderModelCatalogSource[] = ["manual", "discovery"];
const MAX_PROBLEM_DETAIL_LENGTH = 240;

type ProviderRow = ProviderCredential & Record<string, unknown>;
type EditorState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; provider: ProviderCredential };

type ProviderWriteInput = CreateProviderInput | UpdateProviderInput;

function problemDetail(error: ApiError): string {
  return (error.problem?.detail?.trim() || error.message.trim()).slice(0, MAX_PROBLEM_DETAIL_LENGTH);
}

/** 将权限、冲突、服务不可用和网络错误映射为有界页面提示。 */
function formatProviderError(error: unknown, fallback: string, translate: (key: string) => string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 0 || error.code === "network_error") return translate("manager.providers.offline");

  const detail = problemDetail(error);
  if (error.status === 403) {
    return detail
      ? `${translate("manager.providers.forbidden")}：${detail}`
      : translate("manager.providers.forbidden");
  }
  if (error.status === 409 || error.code === "conflict" || error.code.includes("conflict")) {
    return detail
      ? `${translate("manager.providers.conflict")}：${detail}`
      : translate("manager.providers.conflict");
  }
  if (error.status === 503) {
    return detail
      ? `${translate("manager.providers.service_unavailable")}：${detail}`
      : translate("manager.providers.service_unavailable");
  }
  return detail || fallback;
}

function normalizeModels(models: ProviderModelCapability[]): ProviderModelCapability[] {
  return models
    .filter((model) => model.model.trim() !== "")
    .map((model) => ({
      model: model.model.trim(),
      display_name: model.display_name?.trim() ?? "",
      enabled: model.enabled !== false,
      ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
    }));
}

function memberIds(value: string): string[] {
  return [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
}

function protocolMessageKey(value: ProviderApiProtocol): string {
  return `manager.providers.protocol.${value.replace(/-/g, "_")}`;
}

export function ProvidersPage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const translate = useCallback((key: string) => i18n.t(key), [i18n]);
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useProvidersApi();
  const [items, setItems] = useState<ProviderCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ mode: "closed" });
  const [pendingDelete, setPendingDelete] = useState<ProviderCredential | null>(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setItems(await api.list());
    } catch (err) {
      setError(formatProviderError(err, i18n.t("manager.providers.load_error"), translate));
    } finally {
      setLoading(false);
    }
  }, [api, i18n, translate]);

  useEffect(() => { void load(); }, [load]);

  const openCreate = useCallback(() => {
    setActionError(null);
    setNotice(null);
    setEditor({ mode: "create" });
  }, []);

  const openEdit = useCallback((provider: ProviderCredential) => {
    setActionError(null);
    setNotice(null);
    setEditor({ mode: "edit", provider });
  }, []);

  const closeEditor = useCallback(() => {
    if (working) return;
    setActionError(null);
    setEditor({ mode: "closed" });
  }, [working]);

  const handleCreate = useCallback(async (input: CreateProviderInput): Promise<boolean> => {
    setWorking(true);
    setActionError(null);
    try {
      await api.create(input);
      setEditor({ mode: "closed" });
      setNotice(i18n.t("manager.providers.create_ok"));
      await load();
      return true;
    } catch (err) {
      setActionError(formatProviderError(err, i18n.t("manager.providers.create_error"), translate));
      return false;
    } finally {
      setWorking(false);
    }
  }, [api, i18n, load, translate]);

  const handleUpdate = useCallback(async (provider: ProviderCredential, input: UpdateProviderInput): Promise<boolean> => {
    setWorking(true);
    setActionError(null);
    try {
      const updated = await api.update(provider.credential_id, input);
      setEditor({ mode: "closed" });
      setNotice(i18n.t("manager.providers.update_ok", {
        previous: provider.version,
        next: updated?.version ?? provider.version + 1,
      }));
      await load();
      return true;
    } catch (err) {
      setActionError(formatProviderError(err, i18n.t("manager.providers.update_error"), translate));
      return false;
    } finally {
      setWorking(false);
    }
  }, [api, i18n, load, translate]);

  const handleProviderSubmit = useCallback(async (input: ProviderWriteInput): Promise<boolean> => {
    if (editor.mode === "create") {
      if (!("provider_ref" in input)) return false;
      return handleCreate(input);
    }
    if (editor.mode === "edit") {
      if ("provider_ref" in input) return false;
      return handleUpdate(editor.provider, input);
    }
    return false;
  }, [editor, handleCreate, handleUpdate]);

  const handleDelete = useCallback(async (): Promise<void> => {
    if (!pendingDelete) return;
    const provider = pendingDelete;
    setWorking(true);
    setActionError(null);
    try {
      await api.del(provider.credential_id);
      setPendingDelete(null);
      setNotice(i18n.t("manager.providers.delete_ok"));
      await load();
    } catch (err) {
      setActionError(formatProviderError(err, i18n.t("manager.providers.delete_error"), translate));
    } finally {
      setWorking(false);
    }
  }, [api, i18n, load, pendingDelete, translate]);

  const columns = useMemo<TableColumn<ProviderRow>[]>(() => {
    const base: TableColumn<ProviderRow>[] = [
      {
        key: "provider_ref",
        header: i18n.t("manager.providers.col_provider_ref"),
        width: proportional(1),
        renderCell: (provider) => <Code>{provider.provider_ref}</Code>,
      },
      {
        key: "display_name",
        header: i18n.t("manager.providers.col_display_name"),
        width: proportional(1),
        renderCell: (provider) => provider.display_name || "—",
      },
      { key: "api_protocol", header: i18n.t("manager.providers.col_api_protocol"), width: pixel(160) },
      { key: "visibility", header: i18n.t("manager.providers.col_visibility"), width: pixel(110) },
      {
        key: "version",
        header: i18n.t("manager.providers.col_version"),
        width: pixel(90),
        renderCell: (provider) => <Badge label={`v${provider.version}`} />,
      },
    ];
    if (!canWrite) return base;
    return [
      ...base,
      {
        key: "actions",
        header: i18n.t("manager.providers.col_actions"),
        width: pixel(170),
        align: "end",
        resizable: false,
        renderCell: (provider) => (
          <HStack gap={1} justify="end">
            <Button
              label={i18n.t("manager.providers.edit")}
              variant="ghost"
              size="sm"
              data-testid={`provider-edit-${provider.credential_id}`}
              isDisabled={working}
              onClick={() => openEdit(provider)}
            />
            <Button
              label={i18n.t("manager.providers.delete")}
              variant="destructive"
              size="sm"
              data-testid={`provider-delete-${provider.credential_id}`}
              isDisabled={working}
              onClick={() => { setActionError(null); setPendingDelete(provider); }}
            />
          </HStack>
        ),
      },
    ];
  }, [canWrite, i18n, openEdit, working]);

  return (
    <VStack as="section" gap={6} data-testid="providers-page">
      <HStack justify="between" align="center" wrap="wrap" gap={3}>
        <Heading level={1}>{i18n.t("manager.nav.providers")}</Heading>
        {canWrite && <Button label={i18n.t("manager.providers.create")} variant="primary" onClick={openCreate} />}
      </HStack>

      {!canWrite && <Banner status="info" title={i18n.t("manager.providers.read_only")} />}
      {notice && <Banner status="success" title={notice} data-testid="providers-notice" />}
      {actionError && editor.mode === "closed" && <Banner status="error" title={actionError} data-testid="providers-action-error" />}
      {error && <Banner status="error" title={error} data-testid="providers-error" />}

      {loading ? (
        <Card role="status" aria-label={i18n.t("manager.providers.loading")} data-testid="providers-loading">
          <VStack gap={2}><Skeleton height={36} /><Skeleton height={36} index={1} /></VStack>
        </Card>
      ) : error ? (
        <Card data-testid="providers-error-state">
          <VStack gap={3} align="start">
            <Text>{i18n.t("manager.providers.retry_description")}</Text>
            <Button label={i18n.t("common.retry")} variant="secondary" data-testid="providers-retry" onClick={() => void load()} />
          </VStack>
        </Card>
      ) : items.length === 0 ? (
        <Card data-testid="providers-empty">
          <EmptyState title={i18n.t("manager.providers.empty")} description={i18n.t("manager.providers.empty_description")} isCompact />
        </Card>
      ) : (
        <Card padding={0} data-testid="providers-list">
          <Table
            aria-label={i18n.t("manager.nav.providers")}
            tableProps={{ "aria-label": i18n.t("manager.nav.providers") }}
            data={items as ProviderRow[]}
            columns={columns}
            idKey="credential_id"
            hasHover
            textOverflow="truncate"
          />
        </Card>
      )}

      {editor.mode !== "closed" && (
        <ProviderCredentialDialog
          key={editor.mode === "edit" ? editor.provider.credential_id : "create"}
          mode={editor.mode}
          provider={editor.mode === "edit" ? editor.provider : undefined}
          working={working}
          externalError={actionError}
          onClose={closeEditor}
          onSubmit={handleProviderSubmit}
        />
      )}

      <AlertDialog
        isOpen={pendingDelete != null}
        onOpenChange={(isOpen) => { if (!isOpen && !working) setPendingDelete(null); }}
        title={i18n.t("manager.providers.delete_title")}
        description={i18n.t("manager.providers.delete_confirm")}
        cancelLabel={i18n.t("manager.providers.delete_cancel")}
        actionLabel={i18n.t("manager.providers.delete_confirm_ok")}
        isActionLoading={working}
        onAction={() => void handleDelete()}
      />
    </VStack>
  );
}

interface ProviderCredentialDialogProps {
  mode: "create" | "edit";
  provider?: ProviderCredential;
  working: boolean;
  externalError: string | null;
  onClose: () => void;
  onSubmit: (input: ProviderWriteInput) => Promise<boolean>;
}

function ProviderCredentialDialog({
  mode,
  provider,
  working,
  externalError,
  onClose,
  onSubmit,
}: ProviderCredentialDialogProps): ReactNode {
  const i18n = useI18n();
  const isCreate = mode === "create";
  const [providerRef, setProviderRef] = useState(provider?.provider_ref ?? "");
  const [displayName, setDisplayName] = useState(provider?.display_name ?? "");
  const [endpoint, setEndpoint] = useState(provider?.endpoint ?? "");
  const [apiProtocol, setApiProtocol] = useState<ProviderApiProtocol>(provider?.api_protocol ?? "openai-completions");
  const [visibility, setVisibility] = useState<ProviderVisibility>(provider?.visibility ?? "tenant");
  const [allowedMemberIds, setAllowedMemberIds] = useState(provider?.allowed_member_ids.join(", ") ?? "");
  const [modelCatalogSource, setModelCatalogSource] = useState<ProviderModelCatalogSource>(provider?.model_catalog_source ?? "manual");
  const [models, setModels] = useState<ProviderModelCapability[]>(provider?.supported_models ?? []);
  const [secret, setSecret] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const close = useCallback(() => {
    if (working) return;
    setSecret("");
    onClose();
  }, [onClose, working]);

  const updateModel = (index: number, update: Partial<ProviderModelCapability>) => {
    setModels((previous) => previous.map((model, modelIndex) => modelIndex === index ? { ...model, ...update } : model));
  };

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setValidationError(null);
    const trimmedSecret = secret.trim();
    if (!trimmedSecret) {
      setValidationError(i18n.t("manager.providers.secret_required"));
      return;
    }
    const ids = memberIds(allowedMemberIds);
    if (visibility === "members" && ids.length === 0) {
      setValidationError(i18n.t("manager.providers.allowed_member_ids_hint"));
      return;
    }

    const common = {
      display_name: displayName.trim(),
      endpoint: endpoint.trim() || null,
      api_protocol: apiProtocol,
      visibility,
      allowed_member_ids: visibility === "members" ? ids : [],
      supported_models: normalizeModels(models),
      model_catalog_source: modelCatalogSource,
    };
    const input: ProviderWriteInput = isCreate
      ? { provider_ref: providerRef.trim(), secret: trimmedSecret, ...common }
      : { secret: trimmedSecret, ...common };

    if (isCreate && !providerRef.trim()) {
      setValidationError(`${i18n.t("manager.providers.provider_ref")} 为必填`);
      return;
    }
    const success = await onSubmit(input);
    if (success) setSecret("");
  }

  const title = i18n.t(isCreate ? "manager.providers.create_title" : "manager.providers.edit_title");
  const subtitle = isCreate
    ? i18n.t("manager.providers.secret_create_hint")
    : i18n.t("manager.providers.version_hint", { version: provider?.version ?? 0 });

  return (
    <Dialog
      isOpen
      purpose="form"
      width={760}
      maxHeight="90vh"
      aria-label={title}
      onOpenChange={(isOpen) => { if (!isOpen) close(); }}
      data-testid="provider-editor"
    >
      <Layout
        height="auto"
        header={<DialogHeader title={title} subtitle={subtitle} onOpenChange={(isOpen) => { if (!isOpen) close(); }} />}
        content={
          <LayoutContent>
            <form id="provider-editor-form" aria-label={title} onSubmit={(event) => void submit(event)}>
              <VStack gap={5}>
                {externalError && <Banner status="error" title={externalError} data-testid="provider-form-error" />}
                {validationError && <Banner status="error" title={validationError} data-testid="provider-validation-error" />}
                <FormLayout>
                  <TextInput
                    label={i18n.t("manager.providers.provider_ref")}
                    value={providerRef}
                    onChange={setProviderRef}
                    placeholder="my-openai-key"
                    isDisabled={!isCreate || working}
                    isRequired={isCreate}
                  />
                  <TextInput
                    label={i18n.t("manager.providers.display_name")}
                    value={displayName}
                    onChange={setDisplayName}
                    placeholder="OpenAI Key"
                    isDisabled={working}
                    isOptional
                  />
                  <TextInput
                    label={i18n.t("manager.providers.endpoint")}
                    value={endpoint}
                    onChange={setEndpoint}
                    placeholder="https://api.example.com/v1"
                    isDisabled={working}
                    isOptional
                  />
                  <Selector
                    label={i18n.t("manager.providers.api_protocol")}
                    options={PROTOCOLS.map((value) => ({
                      value,
                      label: i18n.t(protocolMessageKey(value)),
                    }))}
                    value={apiProtocol}
                    onChange={(value) => setApiProtocol(value as ProviderApiProtocol)}
                    isDisabled={working}
                    isRequired
                  />
                  <TextInput
                    label={i18n.t("manager.providers.secret")}
                    type="password"
                    value={secret}
                    onChange={setSecret}
                    placeholder="sk-…"
                    isDisabled={working}
                    isRequired
                    data-testid="provider-secret-input"
                  />
                  <Selector
                    label={i18n.t("manager.providers.visibility")}
                    options={VISIBILITIES.map((value) => ({ value, label: i18n.t(`manager.providers.visibility.${value}`) }))}
                    value={visibility}
                    onChange={(value) => setVisibility(value as ProviderVisibility)}
                    isDisabled={working}
                    isRequired
                  />
                  {visibility === "members" && (
                    <TextInput
                      label={i18n.t("manager.providers.allowed_member_ids")}
                      value={allowedMemberIds}
                      onChange={setAllowedMemberIds}
                      placeholder="member-1, member-2"
                      isDisabled={working}
                      isRequired
                    />
                  )}
                  <Selector
                    label={i18n.t("manager.providers.model_catalog_source")}
                    options={MODEL_CATALOG_SOURCES.map((value) => ({
                      value,
                      label: i18n.t(`manager.providers.model_catalog_source.${value}`),
                    }))}
                    value={modelCatalogSource}
                    onChange={(value) => setModelCatalogSource(value as ProviderModelCatalogSource)}
                    isDisabled={working}
                    isRequired
                  />
                </FormLayout>

                <VStack gap={3}>
                  <VStack gap={1}>
                    <Heading level={3}>{i18n.t("manager.providers.supported_models")}</Heading>
                    <Text color="secondary">{i18n.t("manager.providers.supported_models_hint")}</Text>
                  </VStack>
                  {models.map((model, index) => (
                    <Card key={index} variant="muted" padding={3}>
                      <VStack gap={3}>
                        <Grid columns={{ minWidth: 220, repeat: "fit" }} gap={3}>
                          <TextInput
                            label={`${i18n.t("manager.providers.model")} ${index + 1}`}
                            isLabelHidden
                            value={model.model}
                            onChange={(value) => updateModel(index, { model: value })}
                            placeholder={i18n.t("manager.providers.model_placeholder")}
                            isDisabled={working}
                          />
                          <TextInput
                            label={`${i18n.t("manager.providers.model_display_name")} ${index + 1}`}
                            isLabelHidden
                            value={model.display_name ?? ""}
                            onChange={(value) => updateModel(index, { display_name: value })}
                            placeholder={i18n.t("manager.providers.model_display_name_placeholder")}
                            isDisabled={working}
                          />
                        </Grid>
                        <HStack gap={3} align="center" justify="between" wrap="wrap">
                          <CheckboxInput
                            label={i18n.t("manager.providers.model_enabled")}
                            value={model.enabled !== false}
                            onChange={(checked) => updateModel(index, { enabled: checked })}
                            isDisabled={working}
                          />
                          <Button
                            label={i18n.t("manager.providers.remove_model")}
                            variant="destructive"
                            size="sm"
                            isDisabled={working}
                            onClick={() => setModels((previous) => previous.filter((_, modelIndex) => modelIndex !== index))}
                          />
                        </HStack>
                      </VStack>
                    </Card>
                  ))}
                  <Button
                    label={i18n.t("manager.providers.add_model")}
                    variant="secondary"
                    size="sm"
                    isDisabled={working}
                    onClick={() => setModels((previous) => [...previous, { model: "", display_name: "", enabled: true }])}
                  />
                </VStack>
              </VStack>
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              <Button label={i18n.t("manager.providers.cancel")} variant="ghost" isDisabled={working} onClick={close} />
              <Button
                label={i18n.t(isCreate ? "manager.providers.create_submit" : "manager.providers.save")}
                variant="primary"
                type="submit"
                form="provider-editor-form"
                isLoading={working}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
