import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ResearchIndex } from "../data/index.js";

export function registerSearchShowcases(
  server: McpServer,
  index: ResearchIndex,
): void {
  server.tool(
    "search_showcases",
    "キーワードで showcase を全文検索する",
    {
      query: z.string().describe("検索キーワード (スペース区切りで AND 検索)"),
      theme: z
        .string()
        .optional()
        .describe("テーマでフィルタ (pattern, practice, claude, tool, workflow)"),
    },
    async ({ query, theme }) => {
      const results = index.searchShowcases(query, theme);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `"${query}" に一致する showcase が見つかりませんでした。`,
            },
          ],
        };
      }

      const lines = results.map(
        (s) => `- **${s.name}** [${s.theme}]\n  ${s.summary.split("\n")[0]}`,
      );

      const text = [
        `# Showcase 検索結果: "${query}" (${results.length}件)`,
        "",
        ...lines,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    },
  );
}
