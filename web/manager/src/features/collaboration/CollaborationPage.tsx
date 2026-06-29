/** 协作模板页 — 群聊编排提示词配置。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Field, GlassPanel, Input } from "@aiteam/shared/ui";
import { useCollabApi } from "./useCollabApi";
import type { CollabTemplate } from "./types";

const textareaCls = "min-h-[60px] rounded-md border border-gold/20 bg-surface px-md py-sm text-sm text-text-primary outline-none focus:border-gold/50";

export function CollaborationPage(): ReactNode {
  const api = useCollabApi();
  const [tmpl, setTmpl] = useState<CollabTemplate | null>(null);

  const load = useCallback(async () => { try { setTmpl(await api.get()); } catch { /* ignore */ } }, [api]);
  useEffect(() => { void load(); }, [load]);

  const handleSave = useCallback(async () => {
    if (!tmpl) return;
    try { await api.update({ routing_prompt: tmpl.routing_prompt, handoff_prompt: tmpl.handoff_prompt, max_replies_per_message: tmpl.max_replies_per_message }); await load(); } catch { /* ignore */ }
  }, [api, tmpl, load]);

  if (!tmpl) return <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>;

  return (
    <section className="flex flex-col gap-md">
      <h1 className="m-0 text-xl font-bold text-text-primary">协作模板</h1>
      <GlassPanel className="rounded-window p-md">
        <Field label="模板名称"><Input value={tmpl.name} onChange={(e) => setTmpl({ ...tmpl, name: (e.target as HTMLInputElement).value })} /></Field>
        <Field label="路由提示词"><textarea className={textareaCls} value={tmpl.routing_prompt} onChange={(e) => setTmpl({ ...tmpl, routing_prompt: e.target.value })} /></Field>
        <Field label="接续提示词"><textarea className={textareaCls} value={tmpl.handoff_prompt} onChange={(e) => setTmpl({ ...tmpl, handoff_prompt: e.target.value })} /></Field>
        <Field label="单消息最大回复数"><Input type="number" value={tmpl.max_replies_per_message} onChange={(e) => setTmpl({ ...tmpl, max_replies_per_message: Number((e.target as HTMLInputElement).value) })} /></Field>
        <div className="mt-sm"><Button variant="metal" size="sm" onClick={handleSave}>保存</Button></div>
      </GlassPanel>
    </section>
  );
}
