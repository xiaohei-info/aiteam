/** 资料清单：上传、删除、发起生成。 */
import { useRef, type ChangeEvent, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { formatBytes, sourceWarning } from "./labels";
import type { SourceDocument } from "./types";

export const SOURCE_ACCEPT = ".txt,.md,.markdown,.csv,.html,.htm,.docx,.pptx,.xlsx,.pdf,.png,.jpg,.jpeg,.webp";

interface Props {
  sources: SourceDocument[];
  canEdit: boolean;
  hasContent: boolean;
  /** 正文正在编辑：重新生成会整体替换正文，先锁住。 */
  isContentLocked: boolean;
  busy: boolean;
  onUpload: (files: File[]) => void;
  onDelete: (source: SourceDocument) => void;
  /** 已有正文时由页面先弹确认。 */
  onGenerate: () => void;
}

export function SourcesPanel({ sources, canEdit, hasContent, isContentLocked, busy, onUpload, onDelete, onGenerate }: Props): ReactNode {
  const generateHint = sources.length === 0 ? "请先上传至少一份资料" : isContentLocked ? "请先保存或取消正文修改" : undefined;
  const inputRef = useRef<HTMLInputElement>(null);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length) onUpload(files);
  }

  return (
    <Card>
      <VStack gap={4}>
        <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
          <VStack gap={1}>
            <Heading level={2}>行业资料</Heading>
            <Text type="supporting" color="secondary">
              支持 Word / PPT / Excel（新格式）、PDF、Markdown、HTML、TXT、CSV 与图片；单个不超过 20 MB，最多 20 份。
            </Text>
          </VStack>
          {canEdit && (
            <HStack gap={2}>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={SOURCE_ACCEPT}
                aria-label="选择资料文件"
                style={{ display: "none" }}
                disabled={busy}
                onChange={handleChange}
              />
              <Button label="上传资料" variant="secondary" onClick={() => inputRef.current?.click()} isDisabled={busy} />
              <Button
                label={hasContent ? "重新生成" : "开始生成"}
                onClick={onGenerate}
                isDisabled={busy || sources.length === 0 || isContentLocked}
                tooltip={generateHint}
              />
            </HStack>
          )}
        </HStack>
        {sources.length === 0 ? (
          <Text color="secondary">还没有上传资料。</Text>
        ) : (
          <VStack as="ul" gap={2} aria-label="资料清单" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {sources.map((source) => (
              <HStack as="li" key={source.source_id} justify="between" vAlign="center" gap={3}>
                <VStack gap={1}>
                  <Text weight="semibold" wordBreak="break-all">{source.file_name}</Text>
                  <HStack gap={2} wrap="wrap" vAlign="center">
                    <Text type="supporting" color="secondary">
                      {formatBytes(source.size_bytes)} · {source.chunk_count} 段文字 · {source.image_count} 张图片
                    </Text>
                    {source.warnings.map((code) => <Badge key={code} label={sourceWarning(code)} variant="warning" />)}
                  </HStack>
                </VStack>
                {canEdit && (
                  <Button label={`删除 ${source.file_name}`} isIconOnly={false} variant="ghost" onClick={() => onDelete(source)} isDisabled={busy}>
                    删除
                  </Button>
                )}
              </HStack>
            ))}
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
