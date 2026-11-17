/**
 * 分区就地编辑（设计 §3.7）：每一节有自己的「编辑 / 保存 / 取消」，不再整页进入编辑模式。
 *
 * - 同一时间只编辑一节：其它分区的编辑按钮暂不可用，会改动正文的操作（处理敏感项、提交、重新生成、确认）也暂缓，
 *   避免未保存的修改被冲掉或基于旧内容确认。
 * - 编辑中的内容只存在这一节里：服务端数据刷新（轮询、版本冲突后重拉）不会清掉它。
 * - 保存时只把这一节的字段合并到服务端最新正文上；版本冲突后「覆盖保存」也只替换这一节，其它分区保持最新内容。
 */
import { useEffect, useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { GeneratedSolution } from "./types";

export interface SaveFailure {
  message: string;
  /** 草稿在编辑期间被别人改过（版本不一致）。 */
  conflict: boolean;
}

/** 各分区共用的页面上下文。 */
export interface SectionProps {
  solution: GeneratedSolution;
  /** 服务端当前版本；开始编辑时记下，保存时带上。 */
  version: number;
  /** 草稿处于可编辑内容的状态（待处理 / 已驳回）。 */
  canEdit: boolean;
  busy: boolean;
  /** 正在编辑的分区；null 表示没有。 */
  active: string | null;
  onActiveChange: (key: string | null) => void;
  /** `baseVersion` 是这次修改所基于的版本。成功返回 null。 */
  onSave: (next: GeneratedSolution, baseVersion: number) => Promise<SaveFailure | null>;
}

interface Options<T> {
  /** 分区标识，全页唯一。 */
  key: string;
  /** 编辑按钮的文案（也是无障碍名称）。 */
  label: string;
  pick: (solution: GeneratedSolution) => T;
  apply: (solution: GeneratedSolution, draft: T) => GeneratedSolution;
  validate?: (next: GeneratedSolution, draft: T) => string | null;
  /** 其它分区编辑中时，是否在按钮旁写明原因（同一节里有多个按钮时只写一次）。 */
  showLockedNote?: boolean;
}

export function useSectionEdit<T>(props: SectionProps, options: Options<T>) {
  const { solution, version, canEdit, busy, active, onActiveChange, onSave } = props;
  const { key } = options;
  const [draft, setDraft] = useState<T | null>(null);
  const [baseVersion, setBaseVersion] = useState(version);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const editing = draft !== null;
  const locked = active !== null && active !== key;

  useEffect(() => {
    if (!editing) return;
    onActiveChange(key);
    return () => onActiveChange(null);
  }, [editing, key, onActiveChange]);

  function start() {
    setDraft(options.pick(solution));
    setBaseVersion(version);
    setError(null);
    setConflict(false);
  }

  function cancel() {
    setDraft(null);
    setError(null);
    setConflict(false);
  }

  async function save() {
    if (draft === null) return;
    const next = options.apply(solution, draft);
    const problem = options.validate?.(next, draft) ?? null;
    if (problem) { setError(problem); return; }
    setError(null);
    // 冲突后再保存是使用者明确选择的「覆盖」：改用服务端最新版本，并合并到最新正文上。
    const failure = await onSave(next, conflict ? version : baseVersion);
    if (!failure) { cancel(); return; }
    setConflict(failure.conflict);
    if (!failure.conflict) setError(failure.message);
  }

  const editButton: ReactNode = canEdit && !editing ? (
    <HStack gap={2} vAlign="center">
      {locked && options.showLockedNote !== false && <Text type="supporting" color="secondary">其他分区正在编辑</Text>}
      <Button label={options.label} variant="secondary" size="sm" onClick={start} isDisabled={busy || locked} />
    </HStack>
  ) : null;

  const footer: ReactNode = editing ? (
    <VStack gap={2}>
      {error && <Banner status="error" title={error} />}
      {conflict && (
        <Banner
          status="warning"
          title="保存失败：草稿在你编辑期间被其他人改动过"
          description="你在这一节的修改还在，没有丢失。覆盖保存只用你的内容替换这一节，其他分区保持最新内容；也可以放弃修改查看最新内容。"
        />
      )}
      <HStack gap={2}>
        <Button label={conflict ? "覆盖保存" : "保存"} variant="primary" onClick={() => void save()} isLoading={busy} />
        <Button label={conflict ? "放弃我的修改" : "取消"} variant="ghost" onClick={cancel} isDisabled={busy} />
      </HStack>
    </VStack>
  ) : null;

  const update = (change: (value: T) => T) => setDraft((value) => (value === null ? value : change(value)));
  return { editing, draft, update, editButton, footer, setError };
}
