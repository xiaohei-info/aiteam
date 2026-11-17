/**
 * 团队与群聊编排：群主、成员、规则放在同一个盒子里看，底部一次确认。
 * 群主可就地更换（保存后原来的确认自动作废）；规则只读展示，成员引用显示成名字。单人方案不渲染这一块。
 */
import styles from "./workbench.module.css";
import type { ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { Box, Row, Rows } from "./Box";
import type { ConfirmItem, GeneratedSolution } from "./types";
import { ruleParts, type OrchestrationState } from "./workflow";

interface Props {
  solution: GeneratedSolution;
  state: OrchestrationState;
  /** 草稿处于可编辑内容的状态（待处理 / 已驳回）。 */
  canEdit: boolean;
  /** 正文正在编辑：先保存或取消，再确认 / 更换。 */
  isLocked: boolean;
  busy: boolean;
  onChangeCoordinator: (key: string) => void;
  onConfirm: (items: ConfirmItem[]) => void;
}

function RuleLine({ line, solution }: { line: string; solution: Pick<GeneratedSolution, "experts"> }): ReactNode {
  return (
    <Text textWrap="pretty">
      {ruleParts(line, solution).map((part, index) => part.kind === "text"
        ? <span key={index}>{part.text}</span>
        : <strong key={index}>{part.known ? `@${part.name}` : `@${part.key}（未知成员）`}</strong>)}
    </Text>
  );
}

export function TeamSection({ solution, state, canEdit, isLocked, busy, onChangeCoordinator, onConfirm }: Props): ReactNode {
  const lines = (solution.orchestration_rules ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const owner = solution.experts.find((expert) => expert.key === solution.coordinator_key);
  const ownerName = owner?.display_name || solution.coordinator_key;
  const disabled = busy || isLocked;
  return (
    <Box
      id="section-team"
      attention={canEdit && !state.ok}
      title="团队与群聊编排"
      hint="群主负责接收用户的任务、拆解并分派给其他成员，最后汇总结果。"
      extra={<Badge label={state.ok ? "已确认" : "待你确认"} variant={state.ok ? "success" : "warning"} />}
    >
      <Text type="supporting" weight="semibold" color="secondary">成员（{solution.experts.length}）</Text>
      <Rows label="群成员">
        {solution.experts.map((expert) => {
          const isOwner = expert.key === solution.coordinator_key;
          return (
            <Row
              key={expert.key}
              main={<>
                <Text weight={isOwner ? "semibold" : "normal"}>{expert.display_name || expert.key}</Text>
                <Text type="supporting" color="secondary">{expert.category}</Text>
              </>}
              side={<>
                <Badge label={isOwner ? "群主" : "成员"} variant={isOwner ? "info" : "neutral"} />
                {canEdit && !isOwner && (
                  <Button
                    label={`设「${expert.display_name || expert.key}」为群主`}
                    variant="secondary" size="sm" isDisabled={disabled}
                    onClick={() => onChangeCoordinator(expert.key)}
                  >
                    设为群主
                  </Button>
                )}
              </>}
            />
          );
        })}
      </Rows>

      <Text type="supporting" weight="semibold" color="secondary">群聊编排规则</Text>
      <div className={styles.inset}>
        {lines.length > 0 ? (
          <ol aria-label="编排规则">
            {lines.map((line, index) => <li key={index}><RuleLine line={line} solution={solution} /></li>)}
          </ol>
        ) : (
          <Text color="secondary">还没有编排规则：点击下方「编辑正文」补充，或重新生成。</Text>
        )}
        {solution.coordinator_instructions.trim() && (
          <Text type="supporting" color="secondary" textWrap="pretty">协作说明：{solution.coordinator_instructions}</Text>
        )}
      </div>

      {canEdit && (
        <div className={styles.foot}>
          {state.ok ? (
            <Text type="supporting" color="secondary">已确认：群主「{ownerName}」与以上规则。之后修改群主或规则，需要重新确认。</Text>
          ) : (
            <>
              <Text>
                确认后，企业应用此方案建群时，将由<strong>「{ownerName}」</strong>担任群主，并按以上规则协作。
                {state.stale && "（确认之后内容有改动，请重新确认。）"}
              </Text>
              <div>
                <Button label="确认群主与编排规则" variant="primary" size="lg" onClick={() => onConfirm(state.pending)} isDisabled={disabled || state.blocked} />
              </div>
              {isLocked && <Text type="supporting" color="secondary">正文正在编辑：请先保存或取消修改。</Text>}
              {state.blocked && <Text type="supporting" color="secondary">{state.reason}</Text>}
            </>
          )}
        </div>
      )}
    </Box>
  );
}
