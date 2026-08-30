import { useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { AVATAR_ACCEPT, isSafeAvatarDataUrl, readAvatarFile } from "./avatar";

interface AvatarFileInputProps {
  value?: string | null;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export function AvatarPreview({ value }: { value?: string | null }): ReactNode {
  const safeValue = value && isSafeAvatarDataUrl(value) ? value : undefined;
  if (safeValue) {
    return <img src={safeValue} alt="头像预览" width={56} height={56} style={{ objectFit: "cover", borderRadius: "999px" }} />;
  }
  return <Text color={value ? "primary" : "secondary"}>{value ? "已设置头像" : "—"}</Text>;
}

export function AvatarFileInput({ value, disabled = false, onChange }: AvatarFileInputProps): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setError(null);
    try {
      onChange(await readAvatarFile(file));
      setSelectedName(file.name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "头像文件无效");
      event.currentTarget.value = "";
    }
  }

  function clear(): void {
    onChange("");
    setSelectedName(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div data-ui="avatar-file-input">
      <label htmlFor="catalog-avatar-file">头像（可选，本地图片）</label>
      <input
        ref={inputRef}
        id="catalog-avatar-file"
        name="avatar"
        type="file"
        accept={AVATAR_ACCEPT}
        disabled={disabled}
        onChange={(event) => void handleChange(event)}
        aria-describedby="catalog-avatar-help"
        aria-invalid={Boolean(error)}
      />
      <Text id="catalog-avatar-help" type="supporting" color="secondary">
        仅支持 PNG、JPEG、GIF、WEBP，大小不超过 2 MiB；不支持图片 URL。
      </Text>
      {selectedName && <Text type="supporting">已选择：{selectedName}</Text>}
      {value && (
        <div>
          <AvatarPreview value={value} />
          <Button label="移除头像" variant="ghost" type="button" onClick={clear} isDisabled={disabled} />
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
