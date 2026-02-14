import { defineConfig, type DefaultTheme } from 'vitepress'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface Perspective {
  name: string
  file: string
  summary: string
}

interface RepoMeta {
  url: string
  stars: number
  language: string
  description: string
  analyzed_at: string
  perspectives: Perspective[]
}

interface RepoEntry {
  org: string
  repo: string
  meta: RepoMeta
}

function loadRepos(): RepoEntry[] {
  const reposDir = path.resolve(__dirname, '..', 'repos')
  if (!fs.existsSync(reposDir)) return []

  const repos: RepoEntry[] = []

  for (const org of fs.readdirSync(reposDir)) {
    const orgDir = path.join(reposDir, org)
    if (!fs.statSync(orgDir).isDirectory()) continue

    for (const repo of fs.readdirSync(orgDir)) {
      const metaPath = path.join(orgDir, repo, 'meta.yaml')
      if (!fs.existsSync(metaPath)) continue

      const raw = fs.readFileSync(metaPath, 'utf-8')
      const meta = yaml.load(raw) as RepoMeta
      repos.push({ org, repo, meta })
    }
  }

  return repos
}

function loadShowcases(): DefaultTheme.SidebarItem[] {
  const showcasesDir = path.resolve(__dirname, '..', 'showcases')
  if (!fs.existsSync(showcasesDir)) return []

  const groups: Record<string, DefaultTheme.SidebarItem[]> = {}

  for (const file of fs.readdirSync(showcasesDir)) {
    if (!file.endsWith('.md') || file === 'index.md') continue

    const name = file.replace(/\.md$/, '')
    const underscoreIdx = name.indexOf('_')
    const theme = underscoreIdx !== -1 ? name.slice(0, underscoreIdx) : 'other'
    const label = underscoreIdx !== -1 ? name.slice(underscoreIdx + 1) : name

    if (!groups[theme]) groups[theme] = []
    groups[theme].push({
      text: label,
      link: `/showcases/${name}`,
    })
  }

  return Object.entries(groups).map(([theme, items]) => ({
    text: theme,
    collapsed: false,
    items,
  }))
}

function generateSidebar(repos: RepoEntry[]): DefaultTheme.SidebarMulti {
  const sidebar: DefaultTheme.SidebarMulti = {}

  for (const { org, repo, meta } of repos) {
    const base = `/repos/${org}/${repo}/`
    const items: DefaultTheme.SidebarItem[] = [
      { text: 'Overview', link: `${base}` },
      { text: 'Rules', link: `${base}rules` },
    ]

    if (meta.perspectives?.length) {
      items.push({
        text: 'Perspectives',
        collapsed: false,
        items: meta.perspectives.map((p) => ({
          text: p.name,
          link: `${base}${p.name}`,
        })),
      })
    }

    sidebar[base] = [
      {
        text: `${org}/${repo}`,
        items,
      },
    ]
  }

  const showcaseItems = loadShowcases()
  if (showcaseItems.length) {
    sidebar['/showcases/'] = [
      {
        text: 'Showcases',
        items: showcaseItems,
      },
    ]
  }

  return sidebar
}

function generateRewrites(repos: RepoEntry[]): Record<string, string> {
  const rewrites: Record<string, string> = {}

  for (const { org, repo } of repos) {
    rewrites[`repos/${org}/${repo}/overview.md`] =
      `repos/${org}/${repo}/index.md`
  }

  return rewrites
}

function generateNav(repos: RepoEntry[]): DefaultTheme.NavItem[] {
  const repoItems: DefaultTheme.NavItem[] = repos.map(({ org, repo }) => ({
    text: `${org}/${repo}`,
    link: `/repos/${org}/${repo}/`,
  }))

  const nav: DefaultTheme.NavItem[] = [
    {
      text: 'Repos',
      items: repoItems,
    },
    {
      text: 'Showcases',
      link: '/showcases/',
    },
  ]

  return nav
}

const repos = loadRepos()

export default defineConfig({
  title: 'Auto Repo Research',
  description:
    'AI-driven repository research: structured insights from open-source codebases',
  base: '/auto-repo-research/',

  srcExclude: [
    'templates/**',
    '.claude/**',
    'CLAUDE.md',
    'README.md',
  ],

  rewrites: generateRewrites(repos),

  markdown: {
    config(md) {
      // Research Markdown files contain TypeScript generics like <T>, <S> etc.
      // that markdown-it may parse as html_inline tokens. Escape them so Vue's
      // template compiler does not treat them as components.
      const STANDARD_INLINE_TAGS = new Set([
        'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data',
        'del', 'dfn', 'em', 'i', 'img', 'input', 'ins', 'kbd', 'mark',
        'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup',
        'time', 'u', 'var', 'wbr',
      ])
      md.renderer.rules.html_inline = (tokens, idx) => {
        const content = tokens[idx].content
        const tagMatch = content.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/)
        if (tagMatch && STANDARD_INLINE_TAGS.has(tagMatch[1].toLowerCase())) {
          return content
        }
        return content.replace(/</g, '&lt;').replace(/>/g, '&gt;')
      }
    },
  },

  themeConfig: {
    nav: generateNav(repos),
    sidebar: generateSidebar(repos),
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/akifo/auto-repo-research' },
    ],
  },
})
