/** 专家与所需能力：每位专家一行，右侧是推荐的 skill / MCP。仅提示，不影响提交。 */
import type { ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Text } from "@astryxdesign/core/Text";
import { Box, Row, Rows } from "./Box";
import type { GeneratedSolution } from "./types";

export function ExpertsOverview({ solution }: { solution: GeneratedSolution }): ReactNode {
  const group = (solution.mode ?? (solution.experts.length === 1 ? "solo" : "group")) === "group";
  return (
    <Box id="section-experts" title="专家与所需能力" hint="推荐的 skill 与 MCP 只是提示，不影响提交；用户使用方案时，由用户决定是否安装。">
      <Rows label="专家与推荐能力">
        {solution.experts.map((expert) => {
          const skills = expert.skills ?? [];
          const mcps = expert.mcps ?? [];
          return (
            <Row
              key={expert.key}
              main={<>
                <Text weight="semibold">{expert.display_name || expert.key}</Text>
                <Text type="supporting" color="secondary">{expert.category}</Text>
              </>}
              side={<>
                {group && expert.key === solution.coordinator_key && <Badge label="群主" variant="info" />}
                {skills.map((skill) => <Badge key={skill.skill_id} label={`skill · ${skill.skill_id}`} variant="neutral" />)}
                {mcps.map((mcp) => <Badge key={mcp.key} label={`MCP · ${mcp.display_name}`} variant="neutral" />)}
                {skills.length + mcps.length === 0 && <Text type="supporting" color="secondary">无推荐能力</Text>}
              </>}
            />
          );
        })}
      </Rows>
    </Box>
  );
}
