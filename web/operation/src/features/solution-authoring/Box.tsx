/** 工作台分区：带边框的盒子 + 标题，内容用「左名称、右状态 / 按钮」的行排列（对应设计稿的 .box / .row）。 */
import type { ElementType, ReactNode } from "react";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import styles from "./workbench.module.css";

interface BoxProps {
  id?: string;
  title: string;
  hint?: ReactNode;
  /** 标题右侧：状态徽标或操作。 */
  extra?: ReactNode;
  /** 需要使用者处理：用醒目的样式提示该关注这里。 */
  attention?: boolean;
  children: ReactNode;
}

/** 平滑滚动到页面内某个分区（清单与待办里的「去处理」）。 */
export function jumpTo(anchor: string): void {
  const target = document.getElementById(anchor);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  // 目标可能本来就在视野里、页面不会动：用高亮闪一下告诉使用者「就是这里」，并把键盘焦点移过去。
  const flash = styles.flash;
  if (flash) {
    target.classList.remove(flash);
    void target.offsetWidth; // 重新触发动画
    target.classList.add(flash);
    window.setTimeout(() => target.classList.remove(flash), 1800);
  }
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}

export function Box({ id, title, hint, extra, attention, children }: BoxProps): ReactNode {
  return (
    <section id={id} className={`${styles.box} ${attention ? styles.attention : ""}`} aria-label={title}>
      <header className={styles.boxHead}>
        <div className={styles.boxTitle}>
          <Heading level={3} accessibilityLevel={2}>{title}</Heading>
          {hint && <Text type="supporting" color="secondary">{hint}</Text>}
        </div>
        {extra}
      </header>
      {children}
    </section>
  );
}

export function Rows({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return <ul className={styles.rows} aria-label={label}>{children}</ul>;
}

interface RowProps {
  main: ReactNode;
  side?: ReactNode;
  as?: ElementType;
}

export function Row({ main, side, as: Tag = "li" }: RowProps): ReactNode {
  return (
    <Tag className={styles.row}>
      <div className={styles.rowMain}>{main}</div>
      {side && <div className={styles.rowSide}>{side}</div>}
    </Tag>
  );
}
