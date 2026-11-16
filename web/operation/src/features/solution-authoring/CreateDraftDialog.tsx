import { useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import type { DraftCreateInput, ImageRecognition } from "./types";
import { usePublishedModels } from "./usePublishedModels";

const RECOGNITION_OPTIONS = [
  { value: "none", label: "不识别图片（图片列为待人工处理项）" },
  { value: "vision", label: "用所选模型识别图片" },
];
const MAX_SUPPLEMENT = 2000;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** 返回错误文案；成功返回 null（由调用方跳转）。 */
  onCreate: (input: DraftCreateInput) => Promise<string | null>;
}

export function CreateDraftDialog({ isOpen, onClose, onCreate }: Props): ReactNode {
  const models = usePublishedModels(isOpen);
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [recognition, setRecognition] = useState<ImageRecognition>("none");
  const [supplement, setSupplement] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = models.options.find((option) => option.value === model);
  const visionMismatch = recognition === "vision" && selected !== undefined && !selected.supportsImages;

  function close() {
    if (submitting) return;
    setError(null);
    onClose();
  }

  async function submit() {
    if (!title.trim() || !selected) {
      setError("请填写标题并选择模型");
      return;
    }
    if (visionMismatch) {
      setError("所选模型不支持图片输入，请换一个模型或关闭图片识别");
      return;
    }
    setSubmitting(true);
    setError(null);
    const failure = await onCreate({
      title: title.trim(), platform_model_ref: selected.ref, image_recognition: recognition, supplement: supplement.trim(),
    });
    setSubmitting(false);
    if (failure) setError(failure);
  }

  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => { if (!open) close(); }} purpose="form" width={560} aria-label="新建方案草稿">
      <Layout
        header={<DialogHeader title="新建方案草稿" onOpenChange={(open) => { if (!open) close(); }} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <FormLayout>
                <TextInput label="标题" value={title} onChange={setTitle} placeholder="例如：制造业来料质检方案" description="仅运营端内部可见" isRequired isDisabled={submitting} />
                <Selector
                  label="生成模型"
                  options={models.options}
                  value={model || undefined}
                  onChange={setModel}
                  placeholder={models.loading ? "加载中…" : "选择已发布的平台模型"}
                  description="只用于生成方案草稿；发布出的专家不带模型，由企业招募时选择"
                  isRequired
                  isDisabled={submitting || models.loading}
                />
                <Selector
                  label="图片识别"
                  options={RECOGNITION_OPTIONS}
                  value={recognition}
                  onChange={(value) => setRecognition(value as ImageRecognition)}
                  isDisabled={submitting}
                  status={visionMismatch ? { type: "error", message: "所选模型不支持图片输入" } : undefined}
                />
                <TextArea
                  label="补充说明"
                  value={supplement}
                  onChange={setSupplement}
                  rows={3}
                  maxLength={MAX_SUPPLEMENT}
                  placeholder="例如：侧重来料检验环节，专家不超过 4 位"
                  description="告诉 AI 生成时的侧重点；不能改变平台的生成规则"
                  isOptional
                  isDisabled={submitting}
                />
              </FormLayout>
              {models.error && <Banner status="error" title={models.error} />}
              {!models.loading && !models.error && models.options.length === 0 && (
                <Banner status="warning" title="没有可用的模型" description="请先在「大模型服务」里发布至少一个已定价的模型。" />
              )}
              {error && <Banner status="error" title={error} />}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} hAlign="end">
              <Button label="取消" variant="ghost" onClick={close} isDisabled={submitting} />
              <Button label="创建" onClick={() => void submit()} isLoading={submitting} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
