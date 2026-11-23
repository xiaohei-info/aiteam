/**
 * 删除 / 停用的技能或连接器还有员工在用时，让管理员二选一（设计 2026-11-22 §4）：
 * 「同时从这些员工身上去掉」或「只处理目录里这一项，员工配置里保留」，并写明各自的后果；也可以取消。
 * 员工多时列表在内容区滚动，按钮始终在可视区内。
 */
import { ApiError } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { ReactNode } from "react";

export const CAPABILITY_IN_USE = "capability_in_use";

export interface InUseEmployee {
  id: string;
  name: string;
}

/** 409 capability_in_use 的员工列表（后端放在 problem.errors，loc 为 ["employees", 员工 id]）。 */
export function inUseEmployees(err: unknown): InUseEmployee[] | null {
  if (!(err instanceof ApiError) || err.code !== CAPABILITY_IN_USE) return null;
  return (err.problem?.errors ?? []).map((item) => ({ id: String(item.loc[1] ?? ""), name: item.message || String(item.loc[1] ?? "") }));
}

export function CapabilityInUseDialog({ title, action, employees, working, error, onChoose, onCancel }: {
  /** 技能或连接器的名称。 */
  title: string;
  action: "delete" | "disable";
  employees: InUseEmployee[];
  working: boolean;
  /** 上一次选择失败的原因。 */
  error?: string | null;
  /** true：同时从员工身上去掉；false：只处理目录项，员工配置里保留。 */
  onChoose: (removeFromEmployees: boolean) => void;
  onCancel: () => void;
}): ReactNode {
  const verb = action === "delete" ? "删除" : "停用";
  const remove = `${verb}，并从这些员工身上去掉`;
  const keep = action === "delete" ? "只删除，员工配置里保留" : "只停用，员工配置里保留";
  return (
    <Dialog isOpen purpose="form" width={520} maxHeight="90vh" aria-label={`${verb} ${title}`} onOpenChange={(isOpen) => { if (!isOpen && !working) onCancel(); }}>
      <Layout
        header={<DialogHeader title={`${verb} ${title}？`} onOpenChange={(isOpen) => { if (!isOpen && !working) onCancel(); }} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              {error && <Banner status="error" title={error} />}
              <Text>有 {employees.length} 位员工正在使用它，请选择怎么处理：</Text>
              <Text>
                <strong>{remove}</strong>：员工之后不再有这项能力，也不会再出现“用不了”的提示。
              </Text>
              <Text>
                <strong>{keep}</strong>：员工的配置不变，这一项会显示为“{action === "delete" ? "已失效" : "已停用"}”，员工用不上它，由你之后决定是否去掉。
              </Text>
              <Text type="supporting">正在使用的员工：</Text>
              <ul aria-label="正在使用的员工" style={{ margin: 0, paddingInlineStart: 20, maxHeight: "28vh", overflowY: "auto" }}>
                {employees.map((employee) => <li key={employee.id}>{employee.name}</li>)}
              </ul>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end" wrap="wrap">
              <Button label="取消" variant="ghost" isDisabled={working} onClick={onCancel} />
              <Button label={keep} variant="primary" isDisabled={working} onClick={() => onChoose(false)} />
              <Button label={remove} variant="secondary" isLoading={working} onClick={() => onChoose(true)} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
