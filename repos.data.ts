import { defineLoader } from 'vitepress'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

export interface RepoData {
  org: string
  repo: string
  url: string
  stars: number
  language: string
  description: string
  analyzed_at: string
  perspectiveCount: number
}

declare const data: RepoData[]
export { data }

export default defineLoader({
  watch: ['repos/**/meta.yaml'],

  load(): RepoData[] {
    const reposDir = path.resolve(__dirname, 'repos')
    if (!fs.existsSync(reposDir)) return []

    const repos: RepoData[] = []

    for (const org of fs.readdirSync(reposDir)) {
      const orgDir = path.join(reposDir, org)
      if (!fs.statSync(orgDir).isDirectory()) continue

      for (const repo of fs.readdirSync(orgDir)) {
        const metaPath = path.join(orgDir, repo, 'meta.yaml')
        if (!fs.existsSync(metaPath)) continue

        const raw = fs.readFileSync(metaPath, 'utf-8')
        const meta = yaml.load(raw) as Record<string, unknown>

        repos.push({
          org,
          repo,
          url: meta.url as string,
          stars: meta.stars as number,
          language: meta.language as string,
          description: meta.description as string,
          analyzed_at: meta.analyzed_at as string,
          perspectiveCount: Array.isArray(meta.perspectives)
            ? meta.perspectives.length
            : 0,
        })
      }
    }

    return repos.sort((a, b) => b.stars - a.stars)
  },
})
