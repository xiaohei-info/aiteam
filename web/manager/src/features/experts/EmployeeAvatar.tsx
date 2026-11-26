/**
 * 企业端员工头像：列表/详情展示 + 企业自建员工上传。
 *
 * 头像内容接口 `/api/manager/employees/{id}/avatar/content?v=` 要 Bearer，经本端 ApiClient 取图
 * （ProtectedAvatar）；`?v=` 变化即重新取。只有 origin=custom 的员工能换头像，招募/方案/复制来的
 * 员工头像随模板，服务端对它们返回 409 employee_avatar_locked。
 */
import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { ApiError, ProtectedAvatar } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { createManagerApiClient } from "../../api";
import { useSession } from "../../auth/session";
import type { EmployeeAvatarOut, EmployeeConfig } from "./types";

const EMPLOYEE_AVATAR =
  /^\/api\/manager\/employees\/[^/?#]+\/avatar\/content(?:\?v=[0-9]+)?$/u;

/** 员工头像是 Manager 同源受保护路径：只有这类 src 走 Bearer 取图。 */
export function isEmployeeAvatar(src: string): boolean {
  return EMPLOYEE_AVATAR.test(src);
}

/** 与服务端 shared/avatar_image.py 保持一致：GIF 会被转成静态 WebP。 */
export const AVATAR_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export function EmployeeAvatar({
  name,
  src,
  size,
}: {
  name: string;
  src?: string | null;
  size: number;
}): ReactNode {
  const { token, onUnauthorized } = useSession();
  const client = useMemo(
    () => createManagerApiClient({ getToken: () => token, onUnauthorized }),
    [token, onUnauthorized],
  );
  return (
    <ProtectedAvatar
      client={client}
      isProtected={isEmployeeAvatar}
      name={name}
      src={src}
      size={size}
    />
  );
}

/** 读文件为不带 `data:...;base64,` 前缀的 Base64。 */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/** 选文件前的本地校验；返回错误文案，通过返回 null。 */
export function avatarFileProblem(file: {
  type: string;
  size: number;
}): string | null {
  if (!(AVATAR_ACCEPT as readonly string[]).includes(file.type))
    return "只支持 PNG、JPEG、WebP 或 GIF 图片";
  if (file.size <= 0) return "图片是空文件";
  if (file.size > AVATAR_MAX_BYTES) return "图片不能超过 5 MB";
  return null;
}

export interface EmployeeAvatarEditorProps {
  employee: EmployeeConfig;
  upload?: (
    employeeId: string,
    avatar: { mime_type: string; data: string; filename?: string },
  ) => Promise<EmployeeAvatarOut | null>;
  disabled?: boolean;
  onUploaded: (employeeId: string, avatarUrl: string) => void;
}

/** 详情弹窗顶部的头像区：自建员工可更换，其他来源说明头像随模板。 */
export function EmployeeAvatarEditor({
  employee,
  upload,
  disabled,
  onUploaded,
}: EmployeeAvatarEditorProps): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = employee.display_name || "未命名专家";
  const editable = employee.origin === "custom" && Boolean(upload);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // 允许重复选同一个文件（失败后重试）。
    event.target.value = "";
    if (!file || !upload) return;
    const problem = avatarFileProblem(file);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await upload(employee.employee_id, {
        mime_type: file.type,
        data: await readBase64(file),
        filename: file.name || "avatar",
      });
      if (saved) onUploaded(employee.employee_id, saved.avatar_url);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "头像上传失败，请稍后重试",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <VStack gap={2}>
      <HStack gap={4} align="center" data-ui="employee-avatar-editor">
        <EmployeeAvatar name={name} src={employee.avatar_url} size={64} />
        <VStack gap={1}>
          {editable ? (
            <>
              <HStack gap={2} align="center">
                <Button
                  label={employee.avatar_url ? "更换头像" : "上传头像"}
                  variant="secondary"
                  size="sm"
                  isLoading={busy}
                  isDisabled={disabled || busy}
                  onClick={() => inputRef.current?.click()}
                />
                <input
                  ref={inputRef}
                  type="file"
                  accept={AVATAR_ACCEPT.join(",")}
                  hidden
                  data-testid="employee-avatar-input"
                  aria-label="选择头像图片"
                  onChange={(event) => {
                    void handleFile(event);
                  }}
                />
              </HStack>
              <Text type="supporting">
                PNG、JPEG、WebP 或 GIF，不超过 5 MB；保存为 512
                像素静态图，上传后立即生效。
              </Text>
            </>
          ) : (
            <Text type="supporting">头像随人才市场模板，不能单独更换。</Text>
          )}
        </VStack>
      </HStack>
      {error && <Banner status="error" title={error} />}
    </VStack>
  );
}
