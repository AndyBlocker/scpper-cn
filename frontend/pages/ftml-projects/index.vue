<template>
  <div class="ftml-projects-page">
    <!-- Auth check -->
    <div v-if="authLoading" class="center-state">
      <div class="spinner" />
      <p>正在验证登录状态...</p>
    </div>

    <div v-else-if="!isAuthenticated" class="center-state">
      <div class="state-card">
        <h2>需要登录</h2>
        <p>请先登录 SCPper 账号才能使用 FTML 项目功能。</p>
        <NuxtLink to="/account" class="btn btn-primary">前往登录</NuxtLink>
      </div>
    </div>

    <div v-else-if="!hasLinkedWikidot" class="center-state">
      <div class="state-card">
        <h2>需要绑定 Wikidot 账号</h2>
        <p>请先在账号设置中绑定您的 Wikidot 账号才能使用 FTML 项目功能。</p>
        <NuxtLink to="/account" class="btn btn-primary">前往绑定</NuxtLink>
      </div>
    </div>

    <!-- Main content -->
    <template v-else>
      <header class="page-header">
        <h1>FTML 项目</h1>
        <button @click="createNewProject" :disabled="isCreating" class="btn btn-primary">
          <span v-if="isCreating" class="spinner-sm" />
          <template v-else>新建项目</template>
        </button>
      </header>

      <main class="page-content">
        <!-- Loading state -->
        <div v-if="projectsLoading" class="center-state compact">
          <div class="spinner" />
          <p>正在加载...</p>
        </div>

        <!-- Error state -->
        <div v-else-if="projectsError" class="center-state compact">
          <p class="error-text">加载失败: {{ projectsError }}</p>
          <button @click="loadProjects" class="btn">重试</button>
        </div>

        <!-- Empty state -->
        <div v-else-if="projects.length === 0" class="center-state compact">
          <p class="empty-text">还没有项目</p>
          <button @click="createNewProject" :disabled="isCreating" class="btn btn-primary">
            新建项目
          </button>
        </div>

        <!-- Projects list -->
        <div v-else class="projects-list">
          <div
            v-for="project in projects"
            :key="project.id"
            class="project-item"
          >
            <NuxtLink :to="`/ftml-projects/${project.id}`" class="project-main">
              <span class="project-title">{{ project.title }}</span>
              <span class="project-time">{{ formatTime(project.updatedAt) }}</span>
            </NuxtLink>
            <div class="project-actions">
              <button @click="confirmDelete(project)" class="action-btn danger" title="删除项目">
                删除
              </button>
            </div>
          </div>
        </div>
      </main>

      <!-- Delete confirmation modal -->
      <Teleport to="body">
        <div v-if="deleteTarget" class="modal-overlay" @click.self="deleteTarget = null">
          <div class="modal-content">
            <h3>确认删除</h3>
            <p>确定要删除「{{ deleteTarget.title }}」吗？此操作无法撤销。</p>
            <div class="modal-actions">
              <button @click="deleteTarget = null" class="btn">取消</button>
              <button @click="doDelete" :disabled="isDeleting" class="btn btn-danger">
                <span v-if="isDeleting" class="spinner-sm" />
                <template v-else>删除</template>
              </button>
            </div>
          </div>
        </div>
      </Teleport>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAuth } from '~/composables/useAuth'
import { useFtmlProjects, type FtmlProjectMeta } from '~/composables/useFtmlProjects'

definePageMeta({
  layout: 'default'
})

useHead({
  title: 'FTML 项目'
})

const router = useRouter()
const { user, loading: authLoading, isAuthenticated, fetchCurrentUser } = useAuth()
const {
  isLoading: projectsLoading,
  error: projectsError,
  listProjects,
  createProject,
  deleteProject: apiDeleteProject
} = useFtmlProjects()

const projects = ref<FtmlProjectMeta[]>([])
const isCreating = ref(false)
const isDeleting = ref(false)
const deleteTarget = ref<FtmlProjectMeta | null>(null)

const hasLinkedWikidot = computed(() => !!user.value?.linkedWikidotId)

async function loadProjects() {
  console.log('[FtmlProjects] Loading projects list...')
  projects.value = await listProjects(false)
  console.log('[FtmlProjects] Loaded projects:', projects.value.map(p => ({ id: p.id, title: p.title })))
}

async function createNewProject() {
  isCreating.value = true
  const project = await createProject({ title: '未命名项目' })
  isCreating.value = false
  if (project) {
    router.push(`/ftml-projects/${project.id}`)
  }
}

function confirmDelete(project: FtmlProjectMeta) {
  deleteTarget.value = project
}

async function doDelete() {
  if (!deleteTarget.value) return
  isDeleting.value = true
  const success = await apiDeleteProject(deleteTarget.value.id)
  isDeleting.value = false
  if (success) {
    deleteTarget.value = null
    await loadProjects()
  }
}

function formatTime(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return '刚刚'
  if (diffMins < 60) return `${diffMins} 分钟前`
  if (diffHours < 24) return `${diffHours} 小时前`
  if (diffDays < 7) return `${diffDays} 天前`

  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

onMounted(async () => {
  await fetchCurrentUser()
  if (isAuthenticated.value && hasLinkedWikidot.value) {
    await loadProjects()
  }
})
</script>

<style scoped>
.ftml-projects-page {
  @apply min-h-screen bg-neutral-50 dark:bg-neutral-950;
}

/* Center state (loading, auth, empty) */
.center-state {
  @apply min-h-screen flex flex-col items-center justify-center gap-4;
  @apply text-neutral-500 dark:text-neutral-400;
}

.center-state.compact {
  @apply min-h-0 py-20;
}

.state-card {
  @apply bg-white dark:bg-neutral-900 rounded-xl p-8 text-center max-w-sm mx-4;
  @apply border border-neutral-200 dark:border-neutral-800;
}

.state-card h2 {
  @apply text-lg font-semibold mb-2 text-neutral-800 dark:text-neutral-100;
}

.state-card p {
  @apply text-sm text-neutral-600 dark:text-neutral-400 mb-5;
}

.empty-text {
  @apply text-neutral-400 dark:text-neutral-500 mb-2;
}

.error-text {
  @apply text-red-500 mb-2;
}

/* Header */
.page-header {
  @apply flex items-center justify-between px-6 py-4;
  @apply bg-white dark:bg-neutral-900;
  @apply border-b border-neutral-200 dark:border-neutral-800;
}

.page-header h1 {
  @apply text-lg font-semibold text-neutral-800 dark:text-neutral-100;
}

/* Content */
.page-content {
  @apply max-w-3xl mx-auto px-4 py-6;
}

/* Projects list */
.projects-list {
  @apply flex flex-col gap-2;
}

.project-item {
  @apply flex items-center gap-2;
  @apply bg-white dark:bg-neutral-900 rounded-lg;
  @apply border border-neutral-200 dark:border-neutral-800;
  @apply hover:border-neutral-300 dark:hover:border-neutral-700;
  @apply transition-colors;
}

.project-main {
  @apply flex-1 flex items-center justify-between px-4 py-3 min-w-0;
}

.project-title {
  @apply font-medium text-neutral-800 dark:text-neutral-100 truncate;
}

.project-time {
  @apply text-xs text-neutral-400 dark:text-neutral-500 flex-shrink-0 ml-4;
}

.project-actions {
  @apply flex items-center gap-1 pr-2 flex-shrink-0;
}

.action-btn {
  @apply px-2.5 py-1.5 rounded text-xs font-medium;
  @apply text-neutral-500 dark:text-neutral-400;
  @apply hover:bg-neutral-100 dark:hover:bg-neutral-800;
  @apply transition-colors;
}

.action-btn.danger {
  @apply hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20;
}

/* Buttons */
.btn {
  @apply px-4 py-2 rounded-lg text-sm font-medium transition-colors;
  @apply bg-neutral-100 dark:bg-neutral-800;
  @apply text-neutral-700 dark:text-neutral-300;
  @apply hover:bg-neutral-200 dark:hover:bg-neutral-700;
  @apply disabled:opacity-50 disabled:cursor-not-allowed;
  @apply inline-flex items-center justify-center gap-2;
}

.btn-primary {
  @apply bg-sky-500 text-white hover:bg-sky-600;
}

.btn-danger {
  @apply bg-red-500 text-white hover:bg-red-600;
}

/* Modal */
.modal-overlay {
  @apply fixed inset-0 bg-black/50 flex items-center justify-center z-50;
}

.modal-content {
  @apply bg-white dark:bg-neutral-900 rounded-xl p-6 max-w-sm mx-4 w-full;
  @apply border border-neutral-200 dark:border-neutral-800;
}

.modal-content h3 {
  @apply text-base font-semibold mb-2 text-neutral-800 dark:text-neutral-100;
}

.modal-content p {
  @apply text-sm text-neutral-600 dark:text-neutral-400 mb-5;
}

.modal-actions {
  @apply flex justify-end gap-2;
}

/* Spinners */
.spinner {
  @apply w-6 h-6 border-2 border-neutral-200 dark:border-neutral-700;
  @apply border-t-sky-500 rounded-full animate-spin;
}

.spinner-sm {
  @apply w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin;
}
</style>
