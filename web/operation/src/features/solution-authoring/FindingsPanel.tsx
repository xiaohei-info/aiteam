/** 敏感项与提示项：正文里的内容可脱敏 / 删除 / 确认可公开；不在正文里的只需确认已知悉。 */
import type { ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { findingField, findingKind, findingNote, findingStatus } from "./labels";
import type { Finding, FindingResolution, GeneratedSolution } from "./types";

const ORIGIN: Record<Finding["origin"], string> = { rule: "规则扫描", agent: "AI 标注", system: "系统提示" };

interface Props {
  findings: Finding[];
  /** 当前正文：用来把命中位置说成「专家「××」的系统提示词」。 */
  solution: GeneratedSolution | null;
  canResolve: boolean;
  busy: boolean;
  onResolve: (findingId: string, resolution: FindingResolution) => void;
}

export function FindingsPanel({ findings, solution, canResolve, busy, onResolve }: Props): ReactNode {
  const open = findings.filter((item) => item.status === "open").length;
  return (
    <Card>
      <VStack gap={4}>
        <VStack gap={1}>
          <HStack gap={2} vAlign="center">
            <Heading level={2}>敏感项与提示</Heading>
            {open > 0 && <Badge label={`${open} 项待处理`} variant="warning" />}
          </HStack>
          <Text type="supporting" color="secondary">
            发布到公共目录前，每一项都要处理完；这里只显示脱敏后的片段。检查范围是会对外发布的正文（名称、描述、标签、协作说明、交付要求、专家提示词）；「依据」里的资料摘录只在运营端内部展示，不会随方案发布。
          </Text>
        </VStack>
        {findings.length === 0 ? (
          <Text color="secondary">正文里没有发现需要处理的内容。</Text>
        ) : (
          <VStack as="ul" gap={3} aria-label="敏感项清单" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {findings.map((item) => {
              const status = findingStatus(item.status);
              const inContent = item.field_path !== "";
              const note = findingNote(item.kind, item.note);
              const name = `${findingKind(item.kind)} ${item.masked}`.trim();
              return (
                <VStack as="li" key={item.finding_id} gap={2}>
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <Text weight="semibold">{findingKind(item.kind)}</Text>
                    {item.masked && <Text type="code">{item.masked}</Text>}
                    <Badge label={status.label} variant={status.variant} />
                    <Badge label={ORIGIN[item.origin] ?? item.origin} />
                  </HStack>
                  <Text type="supporting" color="secondary">
                    {inContent ? `出现在正文：${findingField(item.field_path, solution)}` : "不在正文中"}
                    {item.locator ? ` · 来源：${item.locator}` : ""}
                    {note ? ` · ${note}` : ""}
                  </Text>
                  {canResolve && item.status === "open" && (
                    <HStack gap={2} wrap="wrap">
                      {inContent ? (
                        <>
                          <Button label="脱敏" tooltip={`把 ${name} 替换为占位符`} variant="secondary" size="sm" onClick={() => onResolve(item.finding_id, "redact")} isDisabled={busy} />
                          <Button label="从正文删除" variant="secondary" size="sm" onClick={() => onResolve(item.finding_id, "remove")} isDisabled={busy} />
                          <Button label="确认可公开" variant="ghost" size="sm" onClick={() => onResolve(item.finding_id, "accept_public")} isDisabled={busy} />
                        </>
                      ) : (
                        <Button label="确认已知悉" variant="secondary" size="sm" onClick={() => onResolve(item.finding_id, "acknowledge")} isDisabled={busy} />
                      )}
                    </HStack>
                  )}
                </VStack>
              );
            })}
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
