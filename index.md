---
layout: home

hero:
  name: Auto Repo Research
  text: AI-driven Repository Research
  tagline: オープンソースのコード構造・設計パターン・技術選定を多角的に分析し、構造化された知見として蓄積する
  actions:
    - theme: brand
      text: Repos
      link: "#repos"
    - theme: alt
      text: GitHub
      link: https://github.com/akifo/auto-repo-research
---

<script setup>
import { data as repos } from './repos.data'
import { withBase } from 'vitepress'
</script>

<div class="vp-doc" style="padding: 0 24px;">

## Researched Repositories {#repos}

<div v-if="repos.length" class="repo-grid">
  <a
    v-for="r in repos"
    :key="`${r.org}/${r.repo}`"
    :href="withBase(`/repos/${r.org}/${r.repo}/`)"
    class="repo-card"
  >
    <h3>{{ r.org }}/{{ r.repo }}</h3>
    <p class="desc">{{ r.description }}</p>
    <div class="meta">
      <span>{{ r.language }}</span>
      <span>{{ r.stars.toLocaleString() }} stars</span>
      <span>{{ r.perspectiveCount }} perspectives</span>
      <span>{{ r.analyzed_at }}</span>
    </div>
  </a>
</div>
<p v-else>No repositories analyzed yet.</p>

</div>

<style>
.repo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
  margin-top: 16px;
}

.repo-card {
  display: block;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 20px;
  text-decoration: none !important;
  color: inherit !important;
  transition: border-color 0.25s, box-shadow 0.25s;
}

.repo-card:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}

.repo-card h3 {
  margin: 0 0 8px;
  font-size: 1.1em;
  color: var(--vp-c-brand-1);
}

.repo-card .desc {
  margin: 0 0 12px;
  font-size: 0.9em;
  color: var(--vp-c-text-2);
  line-height: 1.5;
}

.repo-card .meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 0.8em;
  color: var(--vp-c-text-3);
}
</style>
