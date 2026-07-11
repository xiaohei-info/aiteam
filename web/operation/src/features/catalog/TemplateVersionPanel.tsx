import type { ReactNode } from "react";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { CatalogItem } from "./types";

export type DetailTab = "overview" | "version";

interface TemplateVersionPanelProps {
  item: CatalogItem;
  activeTab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
}

export function TemplateVersionPanel({ item, activeTab, onTabChange }: TemplateVersionPanelProps): ReactNode {
  return (
    <VStack gap={4}>
      <TabList aria-label="目录详情" value={activeTab} onChange={(value) => onTabChange(value as DetailTab)} hasDivider>
        <Tab value="overview" label="概览" />
        <Tab value="version" label="版本信息" />
      </TabList>

      {activeTab === "version" && (
        <Card>
          <VStack gap={3}>
            <Text weight="bold">当前版本</Text>
            <CodeBlock
              code={JSON.stringify({
                template_id: item.template_id,
                catalog_type: item.catalog_type,
                version: item.version,
                status: item.status,
              }, null, 2)}
              language="json"
              width="100%"
              hasCopyButton
              isWrapped
            />
          </VStack>
        </Card>
      )}
    </VStack>
  );
}
