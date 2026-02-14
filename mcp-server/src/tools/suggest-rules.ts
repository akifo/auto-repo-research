import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ResearchIndex } from "../data/index.js";

export function registerSuggestRules(
  server: McpServer,
  index: ResearchIndex,
): void {
  server.tool(
    "suggest_rules",
    "プロジェクトの技術スタックに合ったルールを自動提案する。CLAUDE.md にそのまま貼れる形式で出力。",
    {
      language: z
        .string()
        .optional()
        .describe("プロジェクトの言語 (例: TypeScript)"),
      framework: z
        .string()
        .optional()
        .describe("フレームワーク名 (例: hono, next, mastra)"),
      keywords: z
        .array(z.string())
        .optional()
        .describe("関心のあるキーワード (例: ['middleware', 'error-handling'])"),
      format: z
        .enum(["grouped", "flat"])
        .optional()
        .describe("出力形式: grouped (カテゴリ別, デフォルト) / flat (フラット)"),
    },
    async ({ language, framework, keywords, format }) => {
      const { rules, formatted } = index.suggestRules({
        language,
        framework,
        keywords,
        format: format ?? "grouped",
      });

      if (rules.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "条件に一致するルールが見つかりませんでした。language, framework, keywords のいずれかを指定してください。",
            },
          ],
        };
      }

      const header = [
        `# 推奨ルール (${rules.length}件)`,
        "",
        `> 条件: language=${language ?? "any"}, framework=${framework ?? "any"}, keywords=${
          keywords?.join(", ") ?? "none"
        }`,
        "",
      ].join("\n");

      return {
        content: [{ type: "text", text: header + formatted }],
      };
    },
  );
}
