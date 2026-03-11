<template>
  <div class="archive-page">
    <div class="archive-content">
      <!-- Hero Section - 档案检索终端 -->
      <section class="archive-section">
        <div class="archive-container">
          <div style="text-align: center; margin-bottom: 3rem;">
            <!-- Logo -->
            <div style="display: inline-flex; align-items: center; justify-content: center; width: 4rem; height: 4rem; background: var(--archive-amber); margin-bottom: 2rem;">
              <span style="font-family: var(--font-serif); font-size: 1.75rem; font-weight: 700; color: var(--archive-bg);">SC</span>
            </div>

            <!-- Title -->
            <h1 style="font-family: var(--font-serif); font-size: 3rem; font-weight: 700; color: var(--archive-text-primary); margin-bottom: 0.75rem; letter-spacing: -0.02em;">
              SCPPER-CN
            </h1>
            <p style="font-size: 0.875rem; color: var(--archive-text-secondary); margin-bottom: 2.5rem; letter-spacing: 0.05em;">
              SCP FOUNDATION CHINESE BRANCH / DATA ARCHIVE SYSTEM
            </p>

            <!-- 档案检索终端 -->
            <div class="archive-terminal">
              <div class="terminal-header">
                <div class="terminal-title">
                  ▸ ARCHIVE RETRIEVAL TERMINAL
                </div>
                <div class="terminal-status">
                  <div class="status-indicator"></div>
                  <span>SYSTEM ONLINE</span>
                </div>
              </div>

              <div class="terminal-input-wrapper">
                <input
                  type="text"
                  class="terminal-input"
                  placeholder="ENTER SEARCH QUERY: PAGE / USER / TAG..."
                  v-model="searchQuery"
                  @focus="terminalActive = true"
                  @blur="terminalActive = false"
                />
                <div v-if="!searchQuery && terminalActive" class="terminal-cursor"></div>
              </div>

              <div style="display: flex; justify-content: center; gap: 0.75rem; margin-top: 1.5rem;">
                <NuxtLink to="/ranking" class="archive-btn archive-btn-secondary">
                  USER RANKINGS
                </NuxtLink>
                <NuxtLink to="/search" class="archive-btn archive-btn-secondary">
                  BROWSE WORKS
                </NuxtLink>
                <NuxtLink to="/tools" class="archive-btn archive-btn-secondary">
                  DATA TOOLS
                </NuxtLink>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 统计文件夹 -->
      <section class="archive-section" style="background: var(--archive-surface); padding: 3rem 0;">
        <div class="archive-container">
          <div style="margin-bottom: 2rem;">
            <h2 style="font-family: var(--font-serif); font-size: 1.5rem; font-weight: 600; color: var(--archive-text-primary); margin-bottom: 0.5rem;">
              STATISTICAL OVERVIEW
            </h2>
            <p style="font-size: 0.75rem; color: var(--archive-text-tertiary); text-transform: uppercase; letter-spacing: 0.1em;">
              CLASSIFICATION: PUBLIC / LAST UPDATED: {{ lastUpdated }}
            </p>
          </div>

          <div class="archive-grid archive-grid-4">
            <!-- 用户文件夹 -->
            <div class="archive-folder">
              <div class="folder-number">FILE-001</div>
              <div class="folder-classification">PERSONNEL</div>
              <div class="folder-value">{{ formatNumber(stats.users) }}</div>
              <div class="folder-label">REGISTERED USERS</div>
              <div class="folder-detail">
                {{ formatNumber(stats.activeUsers) }} ACTIVE / {{ formatNumber(stats.contributors) }} CONTRIBUTORS
              </div>
            </div>

            <!-- 页面文件夹 -->
            <div class="archive-folder">
              <div class="folder-number">FILE-002</div>
              <div class="folder-classification">DOCUMENTS</div>
              <div class="folder-value">{{ formatNumber(stats.pages) }}</div>
              <div class="folder-label">TOTAL PAGES</div>
              <div class="folder-detail">
                {{ formatNumber(stats.originals) }} ORIGINAL / {{ formatNumber(stats.translations) }} TRANSLATED
              </div>
            </div>

            <!-- 投票文件夹 -->
            <div class="archive-folder">
              <div class="folder-number">FILE-003</div>
              <div class="folder-classification">RATINGS</div>
              <div class="folder-value">{{ formatNumber(stats.votes) }}</div>
              <div class="folder-label">TOTAL VOTES</div>
              <div class="folder-detail">
                <span style="color: var(--archive-approved);">+{{ formatNumber(stats.upvotes) }}</span>
                <span style="color: var(--archive-text-tertiary);"> / </span>
                <span style="color: var(--archive-classified);">-{{ formatNumber(stats.downvotes) }}</span>
              </div>
            </div>

            <!-- 修订文件夹 -->
            <div class="archive-folder">
              <div class="folder-number">FILE-004</div>
              <div class="folder-classification">REVISIONS</div>
              <div class="folder-value">{{ formatNumber(stats.revisions) }}</div>
              <div class="folder-label">TOTAL EDITS</div>
              <div class="folder-detail">
                CONTINUOUS UPDATES
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 机密通知 -->
      <section class="archive-section">
        <div class="archive-container">
          <div class="classified-notice">
            <div class="classified-header">
              <div class="classified-stamp">
                <AlertTriangle :size="14" />
                NOTICE
              </div>
              <span style="font-size: 0.75rem; color: var(--archive-text-tertiary); text-transform: uppercase; letter-spacing: 0.1em;">
                CONTEST ANNOUNCEMENT / 2026-WINTER
              </span>
            </div>

            <h2 class="classified-title">
              2026冬季征文：循环
            </h2>

            <p class="classified-content">
              专题页已上线，包含赛程节点、完整规则、随机四篇与全部参赛作品列表。所有参赛作品将被归档至竞赛专题数据库，供后续检索与分析。
            </p>

            <div class="classified-metadata">
              <span>SUBMISSION START: 2026-02-17 00:00 GMT+8</span>
              <span>SUBMISSION END: 2026-03-03 23:59 GMT+8</span>
              <span>VOTING END: 2026-03-10 23:59 GMT+8</span>
            </div>

            <NuxtLink to="/winter-contest-2026" class="archive-btn">
              ACCESS CONTEST PAGE
              <ArrowRight :size="16" />
            </NuxtLink>
          </div>
        </div>
      </section>

      <!-- 档案列表 -->
      <section class="archive-section" style="padding-bottom: 4rem;">
        <div class="archive-container">
          <div class="archive-grid archive-grid-2">
            <!-- 热门作品 -->
            <div class="archive-list">
              <div class="archive-list-header">
                <h3 class="archive-list-title">Popular Works</h3>
                <NuxtLink to="/search" class="archive-btn-secondary" style="padding: 0.5rem 1rem; font-size: 0.75rem;">
                  VIEW ALL
                </NuxtLink>
              </div>

              <div>
                <div
                  v-for="(work, index) in popularWorks"
                  :key="work.id"
                  class="archive-item"
                  :style="{ animationDelay: `${index * 0.1}s` }"
                >
                  <div class="archive-item-content">
                    <div class="archive-item-title">{{ work.title }}</div>
                    <div class="archive-item-meta">BY {{ work.author.toUpperCase() }}</div>
                  </div>
                  <div class="archive-item-badge">{{ work.rating }}</div>
                </div>
              </div>
            </div>

            <!-- 活跃用户 -->
            <div class="archive-list">
              <div class="archive-list-header">
                <h3 class="archive-list-title">Active Personnel</h3>
                <NuxtLink to="/ranking" class="archive-btn-secondary" style="padding: 0.5rem 1rem; font-size: 0.75rem;">
                  VIEW ALL
                </NuxtLink>
              </div>

              <div>
                <div
                  v-for="(user, index) in activeUsers"
                  :key="user.id"
                  class="archive-item"
                  :style="{ animationDelay: `${index * 0.1}s` }"
                >
                  <div style="display: flex; align-items: center; gap: 1rem;">
                    <div style="width: 1.5rem; height: 1.5rem; display: flex; align-items: center; justify-content: center; background: var(--archive-bg); border: 1px solid var(--archive-border); font-size: 0.75rem; font-weight: 600; color: var(--archive-text-tertiary);">
                      {{ index + 1 }}
                    </div>
                    <div class="archive-item-content">
                      <div class="archive-item-title">{{ user.name }}</div>
                      <div class="archive-item-meta">{{ user.works }} WORKS</div>
                    </div>
                  </div>
                  <div style="font-family: var(--font-mono); font-size: 0.875rem; color: var(--archive-text-secondary);">
                    {{ user.score }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Search, ArrowRight, AlertTriangle } from 'lucide-vue-next';

const searchQuery = ref('');
const terminalActive = ref(false);

const lastUpdated = new Date().toISOString().split('T')[0];

const stats = {
  users: 34066,
  activeUsers: 5578,
  contributors: 8225,
  pages: 44191,
  originals: 12411,
  translations: 8934,
  votes: 1027108,
  upvotes: 946411,
  downvotes: 80697,
  revisions: 408634,
};

const popularWorks = [
  { id: 1, title: 'SCP-CN-3301', author: 'AndyBlocker', rating: '+601' },
  { id: 2, title: 'SCPPER-CN 2025年度总结', author: 'AndyBlocker', rating: '+213' },
  { id: 3, title: '超形上学导论', author: 'Etinjat', rating: '+616' },
  { id: 4, title: 'SCP-CN-2000', author: 'Various Authors', rating: '+542' },
];

const activeUsers = [
  { id: 1, name: 'Dr_Gears', score: '15,420', works: 89 },
  { id: 2, name: 'qntm', score: '14,230', works: 156 },
  { id: 3, name: 'Djoric', score: '13,890', works: 124 },
  { id: 4, name: 'Clef', score: '12,567', works: 98 },
];

const formatNumber = (num: number) => num.toLocaleString();
</script>

<style scoped>
@import '@/assets/css/archive-theme.css';

/* 页面加载动画 */
.archive-item {
  opacity: 0;
  animation: fadeInUp 0.5s ease-out forwards;
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
