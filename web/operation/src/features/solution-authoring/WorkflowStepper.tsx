/** 流程步骤条：资料 → 生成 → 确认 → 审核 → 发布。填色分段 + 文字状态，不只靠颜色；颜色全部来自主题令牌。 */
import type { ReactNode } from "react";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { Step, StepState } from "./workflow";
import styles from "./workbench.module.css";

const STATE_CLASS: Record<StepState, string> = { done: styles.stepDone ?? "", current: styles.stepCurrent ?? "", todo: "" };
const STATE_TEXT: Record<StepState, string> = { done: "已完成", current: "进行中", todo: "未开始" };

export function WorkflowStepper({ steps }: { steps: Step[] }): ReactNode {
  const current = steps.find((step) => step.state === "current");
  return (
    <VStack gap={2}>
      <ol className={styles.steps} aria-label="流程进度">
        {steps.map((step) => (
          <li key={step.key} className={`${styles.step} ${STATE_CLASS[step.state]}`} aria-current={step.state === "current" ? "step" : undefined}>
            <Text weight={step.state === "current" ? "semibold" : "normal"}>{step.label}</Text>
            <Text type="supporting" color="secondary">{STATE_TEXT[step.state]}</Text>
          </li>
        ))}
      </ol>
      {current?.blocker && <Text type="supporting" color="secondary">当前：{current.blocker}</Text>}
    </VStack>
  );
}
