/** 资料清单：上传、删除、发起生成。 */
import { useRef, type ChangeEvent, type ReactNode, type RefObject } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import styles from "./workbench.module.css";
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
  /** 有分区正在编辑：重新生成会整体替换正文，先锁住。 */
  isContentLocked: boolean;
  busy: boolean;
  onUpload: (files: File[]) => void;
  onDelete: (source: SourceDocument) => void;
  /** 已有正文时由页面先弹确认。 */
  onGenerate: () => void;
  /** 页头「上传资料」主操作借此打开文件选择。 */
  pickerRef?: RefObject<HTMLInputElement | null>;
  /** 页头主操作已承担「上传资料」/「开始生成」时，这里不再重复显示。 */
  hideUpload?: boolean;
  hideGenerate?: boolean;
}

export function SourcesPanel({ sources, canEdit, hasContent, isContentLocked, busy, onUpload, onDelete, onGenerate, pickerRef, hideUpload, hideGenerate }: Props): ReactNode {
  const generateHint = sources.length === 0 ? "请先上传至少一份资料" : isContentLocked ? "请先保存或取消正在编辑的分区" : undefined;
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = pickerRef ?? ownRef;

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length) onUpload(files);
  }

  return (
    <section className={styles.box} aria-label="行业资料">
      <VStack gap={4}>
        <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
          <VStack gap={1}>
            <Heading level={3} accessibilityLevel={2}>行业资料</Heading>
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
              {!hideUpload && <Button label="上传资料" variant="secondary" onClick={() => inputRef.current?.click()} isDisabled={busy} />}
              {!hideGenerate && <Button
                label={hasContent ? "重新生成" : "开始生成"}
                variant={hasContent ? "secondary" : "primary"}
                onClick={onGenerate}
                isDisabled={busy || sources.length === 0 || isContentLocked}
                tooltip={generateHint}
              />}
            </HStack>
          )}
        </HStack>
        {sources.length === 0 ? (
          <Text color="secondary">还没有上传资料。</Text>
        ) : (
          <VStack as="ul" gap={0} aria-label="资料清单" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {sources.map((source) => (
              <HStack as="li" key={source.source_id} justify="between" vAlign="center" gap={3} className={styles.item}>
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
    </section>
  );
}
