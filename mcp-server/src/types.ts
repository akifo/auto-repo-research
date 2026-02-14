export interface ParsedRule {
  priority: "MUST" | "SHOULD" | "AVOID";
  content: string;
  rationale: string;
  category: string;
  repo: string;
}

export interface RepoMeta {
  url: string;
  stars: number;
  language: string;
  license: string;
  description: string;
  analyzed_at: string;
  scale: string;
  perspectives: PerspectiveEntry[];
}

export interface PerspectiveEntry {
  name: string;
  file: string;
  wave: number;
  intent: string;
  summary: string;
}

export interface RepoIndex {
  org: string;
  repo: string;
  meta: RepoMeta;
  rules: ParsedRule[];
  rulesRaw: string;
}

export interface ShowcaseEntry {
  name: string;
  theme: string;
  label: string;
  content: string;
}

export interface ResearchData {
  repos: RepoIndex[];
  showcases: ShowcaseEntry[];
}
