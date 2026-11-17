/**
 * 群聊编排规则编辑器：「插入成员」按钮（@ 引用）与即时校验。只读展示在 TeamSection（引用渲染成成员名字）。
 * 单人方案不显示。校验口径与后端 `validate_member_refs` 一致（见 workflow.ts）。
 */
import type { ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { VStack } from "@astryxdesign/core/VStack";
import type { GeneratedSolution } from "./types";
import { validateRules } from "./workflow";

const MAX_RULES = 8000;

interface Props {
  solution: GeneratedSolution;
  busy: boolean;
  onChange: (rules: string) => void;
}

export function RulesSection({ solution, busy, onChange }: Props): ReactNode {
  const rules = solution.orchestration_rules ?? "";
  const keys = solution.experts.map((expert) => expert.key);
  const problem = validateRules(rules, keys, "group");

  function insert(key: string) {
    const gap = rules && !rules.endsWith("\n") && !rules.endsWith(" ") ? " " : "";
    onChange(`${rules}${gap}@{${key}}`);
  }

  return (
    <VStack gap={2}>
      <TextArea
        label="群聊编排规则"
        value={rules}
        onChange={onChange}
        rows={8}
        maxLength={MAX_RULES}
        description="用 @{成员标识} 引用成员，写出谁先做什么、何时交给谁。企业应用方案时会自动换成实际员工。"
        status={problem ? { type: "error", message: problem } : undefined}
        isRequired
        isDisabled={busy}
      />
      <HStack gap={2} wrap="wrap" vAlign="center">
        <Text type="supporting" color="secondary">插入成员：</Text>
        {solution.experts.map((expert) => (
          <Button
            key={expert.key}
            label={`插入成员 ${expert.display_name || expert.key}`}
            variant="secondary"
            size="sm"
            onClick={() => insert(expert.key)}
            isDisabled={busy}
          >
            {expert.display_name || expert.key}
          </Button>
        ))}
        {solution.experts.length === 0 && <Badge label="没有成员" />}
      </HStack>
      {!problem && <Banner status="success" title="成员引用都有效" />}
    </VStack>
  );
}
