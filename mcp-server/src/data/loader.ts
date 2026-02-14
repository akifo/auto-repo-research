import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type {
  ParsedRule,
  RepoMeta,
  RepoIndex,
  ShowcaseEntry,
  ResearchData,
} from "../types.js";

function parseRules(rulesRaw: string, repo: string): ParsedRule[] {
  const rules: ParsedRule[] = [];
  let currentCategory = "";

  for (const line of rulesRaw.split("\n")) {
    const trimmed = line.trim();

    // Category header: ## カテゴリ名
    const categoryMatch = trimmed.match(/^## (.+)/);
    if (categoryMatch) {
      const name = categoryMatch[1];
      // Skip the metadata sections at the end
      if (name === "ルール優先度の解釈") break;
      currentCategory = name;
      continue;
    }

    // Rule line: - `[MUST]` content / - `[SHOULD]` content / - `[AVOID]` content
    const ruleMatch = trimmed.match(
      /^- `\[(MUST|SHOULD|AVOID)\]` (.+)/
    );
    if (ruleMatch) {
      rules.push({
        priority: ruleMatch[1] as ParsedRule["priority"],
        content: ruleMatch[2],
        rationale: "",
        category: currentCategory,
        repo,
      });
      continue;
    }

    // Rationale line: - 根拠: ...
    const rationaleMatch = trimmed.match(/^- 根拠: (.+)/);
    if (rationaleMatch && rules.length > 0) {
      rules[rules.length - 1].rationale = rationaleMatch[1];
    }
  }

  return rules;
}

export function loadResearchData(baseDir: string): ResearchData {
  const repos = loadRepos(baseDir);
  const showcases = loadShowcases(baseDir);
  return { repos, showcases };
}

function loadRepos(baseDir: string): RepoIndex[] {
  const reposDir = path.join(baseDir, "repos");
  if (!fs.existsSync(reposDir)) return [];

  const repos: RepoIndex[] = [];

  for (const org of fs.readdirSync(reposDir)) {
    const orgDir = path.join(reposDir, org);
    if (!fs.statSync(orgDir).isDirectory()) continue;

    for (const repo of fs.readdirSync(orgDir)) {
      const repoDir = path.join(orgDir, repo);
      const metaPath = path.join(repoDir, "meta.yaml");
      if (!fs.existsSync(metaPath)) continue;

      const raw = fs.readFileSync(metaPath, "utf-8");
      const meta = yaml.load(raw) as RepoMeta;

      let rulesRaw = "";
      let rules: ParsedRule[] = [];
      const rulesPath = path.join(repoDir, "rules.md");
      if (fs.existsSync(rulesPath)) {
        rulesRaw = fs.readFileSync(rulesPath, "utf-8");
        rules = parseRules(rulesRaw, `${org}/${repo}`);
      }

      repos.push({ org, repo, meta, rules, rulesRaw });
    }
  }

  return repos;
}

function loadShowcases(baseDir: string): ShowcaseEntry[] {
  const showcasesDir = path.join(baseDir, "showcases");
  if (!fs.existsSync(showcasesDir)) return [];

  const showcases: ShowcaseEntry[] = [];

  for (const file of fs.readdirSync(showcasesDir)) {
    if (!file.endsWith(".md") || file === "index.md") continue;

    const name = file.replace(/\.md$/, "");
    const underscoreIdx = name.indexOf("_");
    const theme = underscoreIdx !== -1 ? name.slice(0, underscoreIdx) : "other";
    const label = underscoreIdx !== -1 ? name.slice(underscoreIdx + 1) : name;

    const content = fs.readFileSync(
      path.join(showcasesDir, file),
      "utf-8"
    );

    showcases.push({ name, theme, label, content });
  }

  return showcases;
}
