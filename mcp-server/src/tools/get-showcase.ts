import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ResearchIndex } from "../data/index.js";

export function registerGetShowcase(
  server: McpServer,
  index: ResearchIndex,
): void {
  server.tool(
    "get_showcase",
    "showcase ドキュメントの内容を取得する",
    {
      name: z
        .string()
        .describe(
          "showcase 名 (例: pattern_middleware-composition)",
        ),
    },
    async ({ name }) => {
      const showcase = index.findShowcase(name);
      if (!showcase) {
        return {
          content: [
            {
              type: "text",
              text: `Showcase "${name}" が見つかりません。list_research で一覧を確認してください。`,
            },
          ],
          isError: true,
        };
      }

      return { content: [{ type: "text", text: showcase.content }] };
    },
  );
}
