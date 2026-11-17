/** 方案 / 专家的依据（来源片段），只读。 */
import type { ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { Evidence, EvidenceSource } from "./types";

export function EvidenceList({ items, sources }: { items: Evidence[]; sources: Record<string, EvidenceSource> }): ReactNode {
  const known = items.filter((item) => sources[item.chunk_id]);
  if (known.length === 0) return <Text type="supporting" color="secondary">没有引用资料（人工新增或编辑的内容）。</Text>;
  return (
    <VStack gap={2}>
      {known.map((item) => {
        const source = sources[item.chunk_id]!;
        return (
          <VStack key={item.chunk_id} gap={1}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text type="supporting" weight="semibold">{source.source_name} · {source.locator}</Text>
              {source.origin === "image" && <Badge label="来自图片识别" variant="info" />}
              {source.low_confidence && <Badge label="识别置信度低，请核对原图" variant="warning" />}
            </HStack>
            <Text type="supporting" color="secondary">{item.quote || source.excerpt}</Text>
          </VStack>
        );
      })}
    </VStack>
  );
}
