import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ResearchIndex } from "../data/index.js";

export function registerGetRules(
  server: McpServer,
  index: ResearchIndex,
): void {
  server.tool(
    "get_rules",
    "特定リポジトリのルールを取得する。カテゴリや優先度でフィルタ可能。",
    {
      repo: z.string().describe("リポジトリ名 (例: honojs/hono)"),
      category: z
        .string()
        .optional()
        .describe("カテゴリ名でフィルタ (部分一致)"),
      priority: z
        .enum(["MUST", "SHOULD", "AVOID"])
        .optional()
        .describe("優先度でフィルタ"),
    },
    async ({ repo, category, priority }) => {
      const repoData = index.findRepo(repo);
      if (!repoData) {
        return {
          content: [
            {
              type: "text",
              text: `リポジトリ "${repo}" が見つかりません。list_research で一覧を確認してください。`,
            },
          ],
          isError: true,
        };
      }

      const rules = index.getRules(repo, category, priority);
      if (rules.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `条件に一致するルールが見つかりません。(repo: ${repo}, category: ${category ?? "all"}, priority: ${
                priority ?? "all"
              })`,
            },
          ],
        };
      }

      const lines = rules.map(
        (r) => `- \`[${r.priority}]\` ${r.content}\n  - 根拠: ${r.rationale}`,
      );

      const text = [
        `# ${repo} のルール (${rules.length}件)`,
        "",
        ...lines,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    },
  );
}
