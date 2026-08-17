/** Local workspace overview: conversations only. Execution is driven by the Agent event stream. */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "@aiteam/shared/api-client";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useApp } from "../../lib/app-context";
import { listConversations, type Conversation } from "./useWorkspaceApi";

export function WorkspacePage() {
  const { client, i18n } = useApp();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setConversations(await listConversations(client));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("agent.workspace.load_error"));
    }
  }, [client, i18n]);

  useEffect(() => { void load(); }, [load]);

  return (
    <VStack gap={6} role="region" aria-label="本地工作台">
      <Heading level={1}>{i18n.t("agent.nav.workspace")}</Heading>
      <Text as="p" type="supporting">{i18n.t("agent.workspace.summary")}: {conversations.length}</Text>
      {error && <Banner status="error" title={error} />}
      <Card padding={4}>
        <VStack gap={2}>
          <Heading level={2}>{i18n.t("agent.workspace.conversations_title")}</Heading>
          {conversations.length === 0 ? (
            <EmptyState title={i18n.t("agent.workspace.conversations_empty")} headingLevel={3} isCompact />
          ) : (
            <VStack as="ul" gap={1}>
              {conversations.map((conversation) => (
                <VStack as="li" key={conversation.id} gap={1} data-testid="ws-conversation">
                  <Link to="/chat">{conversation.title || conversation.id}</Link>
                  <Badge label={conversation.state} />
                </VStack>
              ))}
            </VStack>
          )}
        </VStack>
      </Card>
    </VStack>
  );
}
