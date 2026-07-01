/**
 * 企业操作面板（S01 操作 UI）。
 *
 * 每行「操作」列触发：下拉按钮组 → 选中动作后弹出内联表单
 *  - 充值：金额 + 支付方式
 *  - 发通知：消息 textarea
 *  - 封禁 / 解封：确认弹窗
 *  - 调配额：新配额值
 *  - 暂停 / 关闭 / 恢复：内联表单（issue #413）
 *
 * 全部经 api.doAction(orgId, body) 提交。成功后 onDone 触发上层刷新。
 */
import { useState, useRef, type FormEvent, type ReactNode } from "react";
import { Button, Field, GlassPanel, Input, Select } from "@aiteam/shared/ui";
import { useI18n } from "../../i18n/context";
import type { AccountsApi } from "./useAccountsApi";
import type { EnterpriseAccount, EnterpriseActionBody } from "./types";

type ActionKind = EnterpriseActionBody["action"];

interface Props {
  api: AccountsApi;
  enterprise: EnterpriseAccount;
  onDone: () => void;
}

export function EnterpriseActions({ api, enterprise, onDone }: Props): ReactNode {
  const i18n = useI18n();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ActionKind | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const name = enterprise.enterprise_name;

  const isClosed = enterprise.operation_status === "closed" || enterprise.status === "closed";
  const isBanned = enterprise.operation_status === "banned" || enterprise.status === "banned";
  const isSuspended = enterprise.operation_status === "suspended" || enterprise.status === "suspended";
  const isClosedOrBanned = isClosed || isBanned;

  function resetState() {
    setActive(null);
    setSubmitting(false);
    setError(null);
    setSuccess(null);
  }

  function toggleMenu() {
    setOpen((v) => !v);
    resetState();
  }

  function pickAction(kind: ActionKind) {
    setActive(kind);
    setError(null);
    setSuccess(null);
  }

  function close() {
    setOpen(false);
    resetState();
  }

  async function runAction(
    action: ActionKind,
    body: Omit<EnterpriseActionBody, "action">,
  ): Promise<void> {
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      await api.doAction(enterprise.org_id, { action, ...body });
      setSuccess(i18n.t("operation.accounts.actions.success"));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitRecharge(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const amount = String(form.get("amount") ?? "").trim();
    const paymentMethod = String(form.get("payment_method") ?? "").trim();
    if (!amount || !paymentMethod) {
      setError(i18n.t("operation.accounts.fieldRequired"));
      return;
    }
    await runAction("recharge", { amount, payment_method: paymentMethod });
  }

  async function submitNotify(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const message = String(form.get("message") ?? "").trim();
    if (!message) {
      setError(i18n.t("operation.accounts.fieldRequired"));
      return;
    }
    await runAction("notify", { message });
  }

  async function submitQuota(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const quota = String(form.get("quota") ?? "").trim();
    if (!quota) {
      setError(i18n.t("operation.accounts.fieldRequired"));
      return;
    }
    await runAction("adjust_quota", { quota });
  }

  async function confirmBan(): Promise<void> {
    await runAction("ban", {});
  }

  async function confirmUnban(): Promise<void> {
    await runAction("unban", {});
  }

  async function submitSuspend(): Promise<void> {
    const reason = reasonRef.current?.value?.trim() ?? "";
    await runAction("suspend", { reason });
  }

  async function submitClose(): Promise<void> {
    const reason = reasonRef.current?.value?.trim() ?? "";
    if (!reason) {
      setError(i18n.t("operation.accounts.fieldRequired"));
      return;
    }
    await runAction("close", { reason });
  }

  async function confirmReactivate(): Promise<void> {
    await runAction("reactivate", {});
  }

  return (
    <div className="relative inline-block text-left">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-expanded={open}
        data-testid={`actions-toggle-${enterprise.org_id}`}
        onClick={toggleMenu}
      >
        {i18n.t("operation.accounts.actions")}
      </Button>

      {open && (
        <div
          className="absolute right-0 z-10 mt-xs w-56 origin-top-right rounded-md border border-gold/20 bg-surface p-sm shadow-lg"
          data-testid={`actions-menu-${enterprise.org_id}`}
        >
          {!active ? (
            <div className="flex flex-col gap-xs" data-testid={`actions-list-${enterprise.org_id}`}>
              <ActionButton
                testId={`action-recharge-${enterprise.org_id}`}
                label={i18n.t("operation.accounts.actions.recharge")}
                onClick={() => pickAction("recharge")}
              />
              <ActionButton
                testId={`action-notify-${enterprise.org_id}`}
                label={i18n.t("operation.accounts.actions.notify")}
                onClick={() => pickAction("notify")}
              />
              {!isClosedOrBanned && !isSuspended ? (
                <ActionButton
                  testId={`action-suspend-${enterprise.org_id}`}
                  label={i18n.t("operation.lifecycle.suspend")}
                  onClick={() => pickAction("suspend")}
                />
              ) : null}
              {isClosed ? null : isBanned ? (
                <ActionButton
                  testId={`action-unban-${enterprise.org_id}`}
                  label={i18n.t("operation.accounts.actions.unban")}
                  onClick={() => pickAction("unban")}
                />
              ) : (
                <ActionButton
                  testId={`action-ban-${enterprise.org_id}`}
                  label={i18n.t("operation.lifecycle.ban")}
                  variant="danger"
                  onClick={() => pickAction("ban")}
                />
              )}
              {(isSuspended || isBanned) && !isClosed ? (
                <ActionButton
                  testId={`action-reactivate-${enterprise.org_id}`}
                  label={i18n.t("operation.lifecycle.reactivate")}
                  onClick={() => void runAction("reactivate", {})}
                />
              ) : null}
              {isClosed ? null : (
                <ActionButton
                  testId={`action-close-${enterprise.org_id}`}
                  label={i18n.t("operation.lifecycle.close")}
                  variant="danger"
                  onClick={() => pickAction("close")}
                />
              )}
              <ActionButton
                testId={`action-quota-${enterprise.org_id}`}
                label={i18n.t("operation.accounts.actions.adjust_quota")}
                onClick={() => pickAction("adjust_quota")}
              />
              <ActionButton
                testId={`actions-close-${enterprise.org_id}`}
                label={i18n.t("operation.accounts.actions.close")}
                onClick={close}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-sm" data-testid={`action-form-${active}-${enterprise.org_id}`}>
              <div className="flex items-center justify-between">
                <Button type="button" variant="ghost" size="sm" onClick={resetState} data-testid={`action-back-${enterprise.org_id}`}>
                  ‹ 返回
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={close} data-testid={`action-panel-close-${enterprise.org_id}`}>
                  {i18n.t("operation.accounts.actions.close")}
                </Button>
              </div>
              <p className="m-0 text-xs text-text-muted">
                {i18n.t("operation.accounts.actionTarget", { name })}
              </p>

              {active === "recharge" && (
                <form className="flex flex-col gap-sm" onSubmit={(e) => void submitRecharge(e)}>
                  <Field label={i18n.t("operation.accounts.rechargeAmount")}>
                    <Input
                      name="amount"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder={i18n.t("operation.accounts.rechargeAmountPlaceholder")}
                      disabled={submitting}
                      data-testid={`recharge-amount-${enterprise.org_id}`}
                    />
                  </Field>
                  <Field label={i18n.t("operation.accounts.paymentMethod")}>
                    <Select
                      name="payment_method"
                      disabled={submitting}
                      data-testid={`recharge-payment-${enterprise.org_id}`}
                      defaultValue="bank"
                    >
                      <option value="bank">{i18n.t("operation.accounts.paymentMethod.bank")}</option>
                      <option value="alipay">{i18n.t("operation.accounts.paymentMethod.alipay")}</option>
                      <option value="wechat">{i18n.t("operation.accounts.paymentMethod.wechat")}</option>
                    </Select>
                  </Field>
                  {error && <p className="m-0 text-xs text-danger">{error}</p>}
                  {success && <p className="m-0 text-xs text-success">{success}</p>}
                  <Button type="submit" size="sm" disabled={submitting} data-testid={`recharge-submit-${enterprise.org_id}`}>
                    {submitting
                      ? i18n.t("operation.accounts.actions.processing")
                      : i18n.t("operation.accounts.actions.confirm")}
                  </Button>
                </form>
              )}

              {active === "notify" && (
                <form className="flex flex-col gap-sm" onSubmit={(e) => void submitNotify(e)}>
                  <Field label={i18n.t("operation.accounts.notifyMessage")}>
                    <textarea
                      name="message"
                      className={textareaCls}
                      placeholder={i18n.t("operation.accounts.notifyMessagePlaceholder")}
                      disabled={submitting}
                      data-testid={`notify-message-${enterprise.org_id}`}
                    />
                  </Field>
                  {error && <p className="m-0 text-xs text-danger">{error}</p>}
                  {success && <p className="m-0 text-xs text-success">{success}</p>}
                  <Button type="submit" size="sm" disabled={submitting} data-testid={`notify-submit-${enterprise.org_id}`}>
                    {submitting
                      ? i18n.t("operation.accounts.actions.processing")
                      : i18n.t("operation.accounts.actions.confirm")}
                  </Button>
                </form>
              )}

              {active === "adjust_quota" && (
                <form className="flex flex-col gap-sm" onSubmit={(e) => void submitQuota(e)}>
                  <Field label={i18n.t("operation.accounts.quota")}>
                    <Input
                      name="quota"
                      type="number"
                      min="0"
                      step="1"
                      placeholder={i18n.t("operation.accounts.quotaPlaceholder")}
                      disabled={submitting}
                      data-testid={`quota-value-${enterprise.org_id}`}
                    />
                  </Field>
                  {error && <p className="m-0 text-xs text-danger">{error}</p>}
                  {success && <p className="m-0 text-xs text-success">{success}</p>}
                  <Button type="submit" size="sm" disabled={submitting} data-testid={`quota-submit-${enterprise.org_id}`}>
                    {submitting
                      ? i18n.t("operation.accounts.actions.processing")
                      : i18n.t("operation.accounts.actions.confirm")}
                  </Button>
                </form>
              )}

              {active === "ban" && (
                <div className="flex flex-col gap-sm">
                  <p className="m-0 text-sm text-warning">
                    {i18n.t("operation.accounts.confirmBan", { name })}
                  </p>
                  {error && <p className="m-0 text-xs text-danger">{error}</p>}
                  {success && <p className="m-0 text-xs text-success">{success}</p>}
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    disabled={submitting}
                    onClick={() => void confirmBan()}
                    data-testid={`ban-confirm-${enterprise.org_id}`}
                  >
                    {submitting
                      ? i18n.t("operation.accounts.actions.processing")
                      : i18n.t("operation.accounts.actions.ban")}
                  </Button>
                </div>
              )}

              {active === "unban" && (
                <div className="flex flex-col gap-sm">
                  <p className="m-0 text-sm text-success">
                    {i18n.t("operation.accounts.confirmUnban", { name })}
                  </p>
                  {error && <p className="m-0 text-xs text-danger">{error}</p>}
                  {success && <p className="m-0 text-xs text-success">{success}</p>}
                  <Button
                    type="button"
                    size="sm"
                    disabled={submitting}
                    onClick={() => void confirmUnban()}
                    data-testid={`unban-confirm-${enterprise.org_id}`}
                  >
                    {submitting
                      ? i18n.t("operation.accounts.actions.processing")
                      : i18n.t("operation.accounts.actions.unban")}
                  </Button>
                </div>
              )}

              {active === "suspend" && (
                <div className="flex flex-col gap-sm">
                  <Field label={i18n.t("operation.lifecycle.reason")}>
                    <Input
                      ref={reasonRef}
                      name="reason"
                      type="text"
                      placeholder={i18n.t("operation.lifecycle.reasonPlaceholder")}
                      disabled={submitting}
                      data-testid={`suspend-reason-${enterprise.org_id}`}
                    />
                  </Field>
                  <p className="m-0 text-xs text-warning">
                    {i18n.t("operation.lifecycle.confirmSuspend", { name })}
                  </p>
                  {error && <p className="m-0 text-xs text-danger">{error}</p>}
                  {success && <p className="m-0 text-xs text-success">{success}</p>}
                  <Button
                    type="button"
                    size="sm"
                    disabled={submitting}
                    onClick={() => void submitSuspend()}
                    data-testid={`suspend-submit-${enterprise.org_id}`}
                  >
                    {submitting
                      ? i18n.t("operation.accounts.actions.processing")
                      : i18n.t("operation.lifecycle.suspend")}
                  </Button>
                </div>
              )}

              {active === "close" && (
                <div className="flex flex-col gap-sm">
                  <Field label={i18n.t("operation.lifecycle.reason")}>
                    <Input
                      ref={reasonRef}
                      name="reason"
                      type="text"
                      placeholder={i18n.t("operation.lifecycle.reasonPlaceholder")}
                      disabled={submitting}
                      data-testid={`close-reason-${enterprise.org_id}`}
                    />
                  </Field>
                  <p className="m-0 text-xs text-danger">
                    {i18n.t("operation.lifecycle.confirmClose", { name })}
                  </p>
                  {error && <p className="m-0 text-xs text-danger">{error}</p>}
                  {success && <p className="m-0 text-xs text-success">{success}</p>}
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    disabled={submitting}
                    onClick={() => void submitClose()}
                    data-testid={`close-submit-${enterprise.org_id}`}
                  >
                    {submitting
                      ? i18n.t("operation.accounts.actions.processing")
                      : i18n.t("operation.lifecycle.close")}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ActionButtonProps {
  testId: string;
  label: string;
  onClick: () => void;
  variant?: "ghost" | "danger";
}

function ActionButton({ testId, label, onClick, variant = "ghost" }: ActionButtonProps): ReactNode {
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      className="w-full justify-start"
      onClick={onClick}
      data-testid={testId}
    >
      {label}
    </Button>
  );
}

const textareaCls =
  "min-h-[80px] w-full rounded-md border border-gold/20 bg-surface px-md py-sm text-sm " +
  "text-text-primary outline-none transition placeholder:text-text-muted " +
  "focus:border-gold/50 focus:ring-2 focus:ring-gold";
