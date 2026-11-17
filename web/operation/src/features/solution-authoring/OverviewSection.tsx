/** 概览：方案名称、描述、标签、交付要求与方案依据。就地编辑，只改这几个字段。 */
import type { ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { Box } from "./Box";
import { EvidenceList } from "./EvidenceList";
import { useSectionEdit, type SectionProps } from "./sectionEdit";
import type { EvidenceSource } from "./types";

interface Draft { display_name: string; description: string; tags: string; output_requirements: string }

export function OverviewSection({ evidenceSources, ...props }: SectionProps & { evidenceSources: Record<string, EvidenceSource> }): ReactNode {
  const { solution, busy } = props;
  const edit = useSectionEdit<Draft>(props, {
    key: "overview",
    label: "编辑概览",
    pick: (s) => ({ display_name: s.display_name, description: s.description, tags: s.tags.join("，"), output_requirements: s.output_requirements }),
    apply: (s, d) => ({
      ...s, display_name: d.display_name, description: d.description, output_requirements: d.output_requirements,
      tags: d.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
    }),
    validate: (next) => (!next.display_name.trim() || !next.description.trim() ? "方案名称和方案描述不能为空" : null),
  });
  const draft = edit.draft;
  return (
    <Box id="section-overview" title="概览" extra={edit.editButton}>
      {draft ? (
        <FormLayout>
          <TextInput label="方案名称" value={draft.display_name} onChange={(display_name) => edit.update((d) => ({ ...d, display_name }))} isRequired isDisabled={busy} />
          <TextArea label="方案描述" value={draft.description} onChange={(description) => edit.update((d) => ({ ...d, description }))} rows={3} maxLength={1000} isRequired isDisabled={busy} />
          <TextInput label="标签" value={draft.tags} onChange={(tags) => edit.update((d) => ({ ...d, tags }))} description="用逗号分隔，最多 8 个" isOptional isDisabled={busy} />
          <TextArea label="交付要求" value={draft.output_requirements} onChange={(output_requirements) => edit.update((d) => ({ ...d, output_requirements }))} rows={4} maxLength={4000} isOptional isDisabled={busy} />
        </FormLayout>
      ) : (
        <VStack gap={3}>
          <VStack gap={1}>
            <Heading level={4}>{solution.display_name}</Heading>
            <Text>{solution.description}</Text>
          </VStack>
          {solution.tags.length > 0 && <HStack gap={2} wrap="wrap">{solution.tags.map((tag) => <Badge key={tag} label={tag} />)}</HStack>}
          <VStack gap={1}><Text weight="semibold">交付要求</Text><Text>{solution.output_requirements || "（未填写）"}</Text></VStack>
          <VStack gap={1}><Text weight="semibold">方案依据</Text><EvidenceList items={solution.evidence} sources={evidenceSources} /></VStack>
        </VStack>
      )}
      {edit.footer}
    </Box>
  );
}
