/**
 * 待办提示（步骤条下方）：还有哪几件事没做、各在页面哪里，点「去处理」直接滚动过去。
 * 全部满足时改为绿色提示，告诉使用者可以提交审核。
 */
import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { jumpTo } from "./Box";
import styles from "./workbench.module.css";
import type { ChecklistRow } from "./workflow";

export function TodoBanner({ rows }: { rows: ChecklistRow[] }): ReactNode {
  const left = rows.filter((row) => !row.ok);
  if (left.length === 0) {
    return (
      <section className={`${styles.todo} ${styles.todoDone}`} aria-label="待办">
        <Text weight="semibold">提交前的检查都已满足，可以在右侧「发布清单」里提交审核。</Text>
      </section>
    );
  }
  return (
    <section className={styles.todo} aria-label="待办">
      <Text weight="semibold">还有 {left.length} 件事需要你处理，完成后才能提交审核</Text>
      <ol aria-label="待办事项">
        {left.map((row, index) => (
          <li key={row.key}>
            <div>
              <Text weight="semibold">{index + 1}. {row.label}</Text>
              <Text type="supporting" color="secondary">{row.reason}</Text>
            </div>
            <Button label={`去处理：${row.label}`} variant={index === 0 ? "primary" : "secondary"} onClick={() => jumpTo(row.anchor)}>去处理</Button>
          </li>
        ))}
      </ol>
    </section>
  );
}
