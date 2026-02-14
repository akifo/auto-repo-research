import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ResearchIndex } from "../data/index.js";

export function registerListResearch(
  server: McpServer,
  index: ResearchIndex,
): void {
  server.tool(
    "list_research",
    "研究済みリポジトリと showcase の一覧を返す",
    {},
    async () => {
      const repos = index.listRepos();
      const showcases = index.listShowcases();

      const repoLines = repos.map(
        (r) =>
          `- **${r.repo}** (${r.language}) — ${r.description} [ルール: ${r.ruleCount}, 視点: ${r.perspectiveCount}]`,
      );

      const showcaseLines = showcases.map(
        (s) => `- **${s.name}** [${s.theme}] ${s.label}`,
      );

      const text = [
        `# 研究済みリポジトリ (${repos.length})`,
        "",
        ...repoLines,
        "",
        `# Showcases (${showcases.length})`,
        "",
        ...showcaseLines,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    },
  );
}
