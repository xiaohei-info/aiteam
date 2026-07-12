/**
 * W-A.2 Loop/任务编排面板（#312）。
 *
 * 展示会话维度的周期任务队列（Loop），支持：
 * - 创建 Loop（标题 + cron 表达式）
 * - 启用 / 停用（进 / 出调度器）
 * - 手动立即触发（fire now，不经 cron 判定）
 *
 * 展示态不入持久化主状态（D6）：只读 Loop 主状态（enabled/disabled、fire_count、
 * last_fired_at），不缓存 run 终态。run 终态走 RunsPanel / timeline。
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import type { AgentApiClient } from "../../lib/api-client";
import {
  createLoop,
  disableLoop,
  enableLoop,
  fireLoopNow,
  listLoops,
  type Loop,
} from "./useLoopsApi";

interface Props {
  client: AgentApiClient;
  conversationId: string;
  refreshSignal?: number;
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function statusBadge(status: Loop["status"]): ReactNode {
  if (status === "enabled") {
    return <Badge variant="success" label="启用" />;
  }
  return <Badge label="停用" />;
}

export function LoopPanel({ client, conversationId, refreshSignal = 0 }: Props): ReactNode {
  const [loops, setLoops] = useState<Loop[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 创建表单局部运行态（不落库、不持久化）
  const [title, setTitle] = useState("");
  const [cron, setCron] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const all = await listLoops(client);
      // 后端当前列全部 Loop；按 conversation_id 过滤到本会话
      setLoops(all.filter((l) => l.conversation_id === conversationId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载 Loop 失败");
    }
  }, [client, conversationId]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const onEnable = async (loopId: string) => {
    setBusy(true);
    setError(null);
    try {
      await enableLoop(client, loopId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "启用失败");
    } finally {
      setBusy(false);
    }
  };

  const onDisable = async (loopId: string) => {
    setBusy(true);
    setError(null);
    try {
      await disableLoop(client, loopId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "停用失败");
    } finally {
      setBusy(false);
    }
  };

  const onFire = async (loopId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fireLoopNow(client, loopId);
      if (!res.ok) setError(res.error ?? "触发失败");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "触发失败");
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setError(null);
    if (!cron.trim()) {
      setFormError("请填写 cron 表达式");
      return;
    }
    setBusy(true);
    try {
      await createLoop(client, {
        conversation_id: conversationId,
        cron: cron.trim(),
        title: title.trim() || null,
        enabled: false,
      });
      setTitle("");
      setCron("");
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card role="region" aria-label="Loop 编排" padding={4}>
      <VStack gap={3}>
      <HStack justify="between" align="center">
        <Text type="label">任务编排</Text>
        <Text type="supporting">{loops.length} 个周期任务</Text>
      </HStack>

      {error && <Banner status="error" title={error} />}

      {loops.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>标题</th>
              <th>Cron</th>
              <th>状态</th>
              <th>触发</th>
              <th>最后触发</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {loops.map((l) => (
              <tr key={l.id}>
                <td>{l.title ?? "未命名"}</td>
                <td><code>{l.cron}</code></td>
                <td>{statusBadge(l.status)}</td>
                <td>{l.fire_count}</td>
                <td>{formatTimestamp(l.last_fired_at)}</td>
                <td>
                  <HStack gap={1}>
                    {l.status === "disabled" ? (
                      <Button type="button" label="启用" variant="secondary" size="sm" isDisabled={busy} onClick={() => void onEnable(l.id)} />
                    ) : (
                      <Button type="button" label="停用" variant="secondary" size="sm" isDisabled={busy} onClick={() => void onDisable(l.id)} />
                    )}
                    <Button type="button" label="触发" variant="primary" size="sm" isDisabled={busy || l.status === "disabled"} onClick={() => void onFire(l.id)} />
                  </HStack>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={onCreate}>
        <VStack gap={2}>
        <HStack gap={2} wrap="wrap">
          <TextInput label="标题" value={title} placeholder="可选，如 每日报告" onChange={setTitle} isDisabled={busy} />
          <TextInput label="Cron 表达式" value={cron} placeholder="分 时 日 月 周，如 0 9 * * *" onChange={setCron} isDisabled={busy} />
        </HStack>
        {formError && <Banner status="error" title={formError} />}
        <HStack justify="end">
          <Button type="submit" label="创建 Loop" variant="primary" size="sm" isDisabled={busy} />
        </HStack>
        </VStack>
      </form>
      </VStack>
    </Card>
  );
}
