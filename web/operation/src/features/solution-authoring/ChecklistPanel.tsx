/**
 * 发布清单（右侧栏）：每条一行，右侧是状态；提交审核按钮放在清单底部，不可用的原因直接写在按钮旁。
 * 处理动作都在左侧对应分节里，这里的「去处理」只是跳转。
 */
import styles from "./workbench.module.css";
import type { ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { Box, jumpTo, Row, Rows } from "./Box";
import type { ChecklistRow, PrimaryAction } from "./workflow";

interface Props {
  rows: ChecklistRow[];
  /** 提交审核主操作；没有可做的事为 null。 */
  submit: PrimaryAction | null;
  busy: boolean;
  onSubmit: () => void;
}

export function ChecklistPanel({ rows, submit, busy, onSubmit }: Props): ReactNode {
  return (
    <Box id="section-checklist" title="发布清单">
      <Rows label="提交前检查清单">
        {rows.map((row) => (
          <Row
            key={row.key}
            main={<>
              <Text weight="semibold">{row.label}</Text>
              {!row.ok && <Text type="supporting" color="secondary">{row.reason}。<a href={`#${row.anchor}`} onClick={(event) => { event.preventDefault(); jumpTo(row.anchor); }}>去处理</a></Text>}
            </>}
            side={<Badge label={row.ok ? "已满足" : "未满足"} variant={row.ok ? "success" : "warning"} />}
          />
        ))}
      </Rows>
      {submit && (
        <div className={styles.foot}>
          <div>
            <Button label={submit.label} variant="primary" size="lg" onClick={onSubmit} isDisabled={busy || submit.disabledReason !== undefined} />
          </div>
          {submit.disabledReason && <Text type="supporting" color="secondary">{submit.disabledReason}</Text>}
        </div>
      )}
    </Box>
  );
}
