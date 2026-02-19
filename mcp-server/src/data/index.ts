import type { ParsedRule, RepoIndex, ResearchData, ShowcaseEntry } from "../types.js";

export class ResearchIndex {
  private data: ResearchData;

  constructor(data: ResearchData) {
    this.data = data;
  }

  listRepos(): Array<{
    repo: string;
    language: string;
    description: string;
    ruleCount: number;
    perspectiveCount: number;
  }> {
    return this.data.repos.map((r) => ({
      repo: `${r.org}/${r.repo}`,
      language: r.meta.language,
      description: r.meta.description,
      ruleCount: r.rules.length,
      perspectiveCount: r.meta.perspectives?.length ?? 0,
    }));
  }

  listShowcases(): Array<{ name: string; theme: string; label: string; summary: string; }> {
    return this.data.showcases.map((s) => ({
      name: s.name,
      theme: s.theme,
      label: s.label,
      summary: s.summary,
    }));
  }

  findRepo(repo: string): RepoIndex | undefined {
    return this.data.repos.find((r) => `${r.org}/${r.repo}` === repo);
  }

  findShowcase(name: string): ShowcaseEntry | undefined {
    return this.data.showcases.find((s) => s.name === name || s.label === name);
  }

  getRules(
    repo: string,
    category?: string,
    priority?: string,
  ): ParsedRule[] {
    const repoData = this.findRepo(repo);
    if (!repoData) return [];

    let rules = repoData.rules;
    if (category) {
      const lower = category.toLowerCase();
      rules = rules.filter((r) => r.category.toLowerCase().includes(lower));
    }
    if (priority) {
      const upper = priority.toUpperCase();
      rules = rules.filter((r) => r.priority === upper);
    }
    return rules;
  }

  searchRules(query: string, priority?: string): ParsedRule[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    let allRules = this.data.repos.flatMap((r) => r.rules);

    if (priority) {
      const upper = priority.toUpperCase();
      allRules = allRules.filter((r) => r.priority === upper);
    }

    return allRules.filter((rule) => {
      const searchText = [
        rule.content,
        rule.category,
        rule.rationale,
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((term) => searchText.includes(term));
    });
  }

  searchShowcases(
    query: string,
    theme?: string,
  ): Array<{ name: string; theme: string; summary: string; }> {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    let showcases = this.data.showcases;

    if (theme) {
      const lower = theme.toLowerCase();
      showcases = showcases.filter((s) => s.theme.toLowerCase() === lower);
    }

    return showcases
      .filter((s) => {
        const searchText = [s.content, s.summary, s.name].join(" ").toLowerCase();
        return terms.every((term) => searchText.includes(term));
      })
      .map((s) => ({
        name: s.name,
        theme: s.theme,
        summary: s.summary,
      }));
  }

  suggestShowcases(opts: {
    language?: string;
    framework?: string;
    keywords?: string[];
  }): Array<ShowcaseEntry & { score: number; }> {
    const scored: Array<ShowcaseEntry & { score: number; }> = [];

    for (const showcase of this.data.showcases) {
      let score = 0;

      // Framework match against sourceRepos
      if (opts.framework) {
        const fw = opts.framework.toLowerCase();
        if (showcase.sourceRepos.some((r) => r.toLowerCase().includes(fw))) {
          score += 10;
        }
      }

      // Language match against sourceRepos (check corresponding repo meta)
      if (opts.language) {
        const lang = opts.language.toLowerCase();
        for (const srcRepo of showcase.sourceRepos) {
          const repo = this.findRepo(srcRepo);
          if (repo && repo.meta.language.toLowerCase() === lang) {
            score += 2;
            break;
          }
        }
      }

      // Keyword matches against summary + content
      if (opts.keywords) {
        for (const kw of opts.keywords) {
          const lower = kw.toLowerCase();
          if (showcase.summary.toLowerCase().includes(lower)) score += 3;
          else if (showcase.content.toLowerCase().includes(lower)) score += 1;
          if (showcase.name.toLowerCase().includes(lower)) score += 2;
        }
      }

      // Theme-based bonus: underrepresented themes get a small boost
      if (showcase.theme === "claude" || showcase.theme === "tool" || showcase.theme === "workflow") {
        score += 1;
      }

      if (score > 0) {
        scored.push({ ...showcase, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  suggestRules(opts: {
    language?: string;
    framework?: string;
    keywords?: string[];
    format?: "grouped" | "flat";
  }): { rules: Array<ParsedRule & { score: number; }>; formatted: string; } {
    const scored: Array<ParsedRule & { score: number; }> = [];

    for (const repo of this.data.repos) {
      for (const rule of repo.rules) {
        let score = 0;

        // Language match
        if (opts.language) {
          const lang = opts.language.toLowerCase();
          if (repo.meta.language.toLowerCase() === lang) {
            score += 2;
          }
        }

        // Framework match (repo name or description)
        if (opts.framework) {
          const fw = opts.framework.toLowerCase();
          const repoName = `${repo.org}/${repo.repo}`.toLowerCase();
          const desc = repo.meta.description.toLowerCase();
          if (repoName.includes(fw) || desc.includes(fw)) {
            score += 10;
          }
        }

        // Keyword matches
        if (opts.keywords) {
          for (const kw of opts.keywords) {
            const lower = kw.toLowerCase();
            if (rule.content.toLowerCase().includes(lower)) score += 3;
            else if (rule.category.toLowerCase().includes(lower)) score += 2;
            else if (rule.rationale.toLowerCase().includes(lower)) score += 1;
          }
        }

        // MUST rules get a small bonus (generally more universal)
        if (rule.priority === "MUST") score += 1;

        if (score > 0) {
          scored.push({ ...rule, score });
        }
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const formatted = formatSuggestions(scored, opts.format ?? "grouped");
    return { rules: scored, formatted };
  }
}

function formatSuggestions(
  rules: Array<ParsedRule & { score: number; }>,
  format: "grouped" | "flat",
): string {
  if (rules.length === 0) return "マッチするルールが見つかりませんでした。";

  if (format === "flat") {
    return rules
      .map((r) => `- \`[${r.priority}]\` ${r.content} (from ${r.repo})`)
      .join("\n");
  }

  // Grouped by category
  const groups = new Map<string, Array<ParsedRule & { score: number; }>>();
  for (const rule of rules) {
    const key = rule.category;
    const list = groups.get(key) ?? [];
    list.push(rule);
    groups.set(key, list);
  }

  const sections: string[] = [];
  for (const [category, categoryRules] of groups) {
    const lines = categoryRules.map(
      (r) => `- \`[${r.priority}]\` ${r.content}\n  - 根拠: ${r.rationale} (from ${r.repo})`,
    );
    sections.push(`## ${category}\n\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}
