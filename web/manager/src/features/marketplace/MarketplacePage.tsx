/**
 * 人才市场页（AITEAM-290 / GH#404）。
 *
 * Manager 端唯一的人才招募入口：浏览可招募专家模板 + 一键招募为 tenant 实例。
 * 招募无需手填实例标识（slug）—— 由后端自动生成（PRD P03/P04，AITEAM-356）。
 *
 * 设计对齐 PRD P03/P04：招募无需手工填写实例标识（slug），服务端按模板自动创建实例；
 * 招募动作为一键按钮，入参仅 template_id。
 *
 * 招募成功后提示可前往专家实例配置 Provider / LLM（AITEAM-683）。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useExpertsApi } from "../experts/useExpertsApi";
import type { ExpertTemplate } from "../experts/types";

export function MarketplacePage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useExpertsApi();

  const [templates, setTemplates] = useState<ExpertTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTemplates(await api.listTemplates());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.experts.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  useEffect(() => { void load(); }, [load]);

  const runAction = useCallback(
    async (fn: () => Promise<unknown>, successKey: string) => {
      setActionError(null);
      setNotice(null);
      try {
        await fn();
        setNotice(i18n.t(successKey));
        await load();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : i18n.t("manager.experts.action_error"));
      }
    },
    [i18n, load],
  );

  return (
    <VStack as="section" gap={6}>
      <Heading level={1}>{i18n.t("manager.nav.marketplace")}</Heading>
      {notice && (
        <Banner
          status="success"
          title={notice}
          endContent={
            <Button
              label={i18n.t("manager.experts.edit_config")}
              href="/experts"
              variant="ghost"
              size="sm"
              data-testid="goto-experts"
            />
          }
        />
      )}
      {actionError && <Banner status="error" title={actionError} />}
      {error && <Banner status="error" title={error} />}

      <VStack gap={3}>
        <Heading level={2}>
          {i18n.t("manager.experts.templates_title")}
        </Heading>
        {loading ? (
          <VStack gap={2} role="status" aria-label={i18n.t("manager.experts.loading")}>
            <Text color="secondary">{i18n.t("manager.experts.loading")}</Text>
            <Skeleton height={96} />
          </VStack>
        ) : templates.length === 0 ? (
          <EmptyState
            headingLevel={3}
            title={i18n.t("manager.experts.templates_empty")}
          />
        ) : (
          <Grid columns={{ minWidth: 280, repeat: "fit" }} gap={3} data-testid="template-list">
            {templates.map((t) => (
              <Card
                key={`${t.template_id}@${t.version}`}
                role="article"
                aria-label={t.display_name}
                data-testid="template-row"
                padding={4}
              >
                <VStack gap={3}>
                  <VStack gap={1}>
                    <Heading level={3}>{t.display_name}</Heading>
                    <Text type="supporting">版本 v{t.version}</Text>
                  </VStack>
                  {t.persona && <Text color="secondary">{t.persona}</Text>}
                {canWrite && (
                    t.is_recruited ? (
                      <Button
                        label={i18n.t("manager.experts.recruited")}
                        size="sm"
                        variant="secondary"
                        isDisabled
                      />
                    ) : (
                    <Button
                      label={i18n.t("manager.experts.recruit")}
                      size="sm"
                      variant="primary"
                      clickAction={() => runAction(
                      () => api.recruitExpert({ template_id: t.template_id }),
                      "manager.experts.recruit_ok",
                      )}
                    />
                    )
                )}
                </VStack>
              </Card>
            ))}
          </Grid>
        )}
      </VStack>
    </VStack>
  );
}
