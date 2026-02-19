#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResearchIndex } from "./data/index.js";
import { loadResearchData } from "./data/loader.js";
import { registerGetRules } from "./tools/get-rules.js";
import { registerGetShowcase } from "./tools/get-showcase.js";
import { registerListResearch } from "./tools/list-research.js";
import { registerSearchRules } from "./tools/search-rules.js";
import { registerSearchShowcases } from "./tools/search-showcases.js";
import { registerSuggestRules } from "./tools/suggest-rules.js";
import { registerSuggestShowcases } from "./tools/suggest-showcases.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.resolve(__dirname, "..", "..");

const data = loadResearchData(baseDir);
const index = new ResearchIndex(data);

const server = new McpServer({
  name: "auto-repo-research",
  version: "0.1.0",
});

registerListResearch(server, index);
registerGetRules(server, index);
registerGetShowcase(server, index);
registerSearchRules(server, index);
registerSearchShowcases(server, index);
registerSuggestRules(server, index);
registerSuggestShowcases(server, index);

const transport = new StdioServerTransport();
await server.connect(transport);
