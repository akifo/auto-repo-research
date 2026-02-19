import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ResearchIndex } from "../data/index.js";

export function registerSuggestShowcases(
  server: McpServer,
  index: ResearchIndex,
): void {
  server.tool(
    "suggest_showcases",
    "プロジェクトの技術スタックに合った showcase を提案する",
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
    },
    async ({ language, framework, keywords }) => {
      const results = index.suggestShowcases({ language, framework, keywords });

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "条件に一致する showcase が見つかりませんでした。language, framework, keywords のいずれかを指定してください。",
            },
          ],
        };
      }

      const lines = results.map(
        (s) => `- **${s.name}** [${s.theme}] (score: ${s.score})\n  ${s.summary.split("\n")[0]}`,
      );

      const text = [
        `# 推奨 Showcase (${results.length}件)`,
        "",
        `> 条件: language=${language ?? "any"}, framework=${framework ?? "any"}, keywords=${
          keywords?.join(", ") ?? "none"
        }`,
        "",
        ...lines,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    },
  );
}
