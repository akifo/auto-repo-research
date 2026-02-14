import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ResearchIndex } from "../data/index.js";

export function registerSearchRules(
  server: McpServer,
  index: ResearchIndex,
): void {
  server.tool(
    "search_rules",
    "キーワードで全リポジトリのルールを横断検索する",
    {
      query: z.string().describe("検索キーワード (スペース区切りで AND 検索)"),
      priority: z
        .enum(["MUST", "SHOULD", "AVOID"])
        .optional()
        .describe("優先度でフィルタ"),
    },
    async ({ query, priority }) => {
      const results = index.searchRules(query, priority);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `"${query}" に一致するルールが見つかりませんでした。`,
            },
          ],
        };
      }

      const lines = results.map(
        (r) =>
          `- \`[${r.priority}]\` ${r.content}\n  - カテゴリ: ${r.category} | リポ: ${r.repo}\n  - 根拠: ${r.rationale}`,
      );

      const text = [
        `# 検索結果: "${query}" (${results.length}件)`,
        "",
        ...lines,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    },
  );
}
