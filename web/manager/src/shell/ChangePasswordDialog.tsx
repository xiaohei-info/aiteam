/** 自助设置新密码对话框。成功后其它设备的登录会失效，当前会话保留。 */
import { useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { createManagerApiClient } from "../api/client";
import { useSession } from "../auth/session";
import type { PasswordPolicy } from "./useMe";

export function policyHint(p: PasswordPolicy): string {
  const parts = [`至少 ${p.min_length} 位`];
  if (p.require_upper) parts.push("大写字母");
  if (p.require_lower) parts.push("小写字母");
  if (p.require_digit) parts.push("数字");
  if (p.require_symbol) parts.push("符号");
  return parts.join("、");
}

const MESSAGES: Record<string, string> = {
  old_password_incorrect: "当前密码不正确",
  too_many_attempts: "输错次数过多，请 15 分钟后再试",
};

export function ChangePasswordDialog({ policy, onClose }: { policy: PasswordPolicy; onClose: () => void }): ReactNode {
  const { token, onUnauthorized } = useSession();
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm !== "" && confirm !== newPw;
  const canSubmit = oldPw !== "" && newPw !== "" && confirm === newPw && !working;

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setWorking(true);
    setError(null);
    try {
      const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
      await client.post("/api/auth/password", { body: { old_password: oldPw, new_password: newPw } });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? (MESSAGES[err.code] ?? err.message) : "设置失败，请重试");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog isOpen purpose="form" width={460} aria-label="设置新密码" onOpenChange={(open) => { if (!open && !working) onClose(); }}>
      <VStack gap={4}>
        <DialogHeader title="设置新密码" onOpenChange={(open) => { if (!open && !working) onClose(); }} />
        {done ? (
          <>
            <Banner status="success" title="新密码已生效" />
            <Text color="secondary">其它设备上的登录已失效，需用新密码重新登录；当前页面不受影响。</Text>
            <HStack justify="end"><Button label="完成" variant="primary" onClick={onClose} /></HStack>
          </>
        ) : (
          <>
            {error && <Banner status="error" title={error} />}
            {/* autocomplete 让密码管理器识别旧/新密码；任一框内回车即提交（未填完整时不提交）。 */}
            <TextInput label="当前密码" type="password" value={oldPw} onChange={setOldPw} isRequired isDisabled={working}
              onEnter={() => void submit()} {...({ autoComplete: "current-password" } as Record<string, string>)} />
            <TextInput label="新密码" type="password" value={newPw} onChange={setNewPw} isRequired isDisabled={working} description={policyHint(policy)}
              onEnter={() => void submit()} {...({ autoComplete: "new-password" } as Record<string, string>)} />
            <TextInput label="确认新密码" type="password" value={confirm} onChange={setConfirm} isRequired isDisabled={working}
              status={mismatch ? { type: "error", message: "两次输入不一致" } : undefined}
              onEnter={() => void submit()} {...({ autoComplete: "new-password" } as Record<string, string>)} />
            <HStack justify="end" gap={2}>
              <Button label="取消" variant="secondary" onClick={onClose} isDisabled={working} />
              <Button label="确认" variant="primary" onClick={() => void submit()} isLoading={working} isDisabled={!canSubmit} />
            </HStack>
          </>
        )}
      </VStack>
    </Dialog>
  );
}
