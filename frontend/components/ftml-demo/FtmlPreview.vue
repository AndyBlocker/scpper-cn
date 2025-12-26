<template>
  <div class="preview-pane">
    <div class="pane-header">
      <div class="pane-title">
        <span>预览</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="pane-stats" v-if="renderSummary">{{ renderSummary }}</span>
        <div v-if="isLoading" class="loading-spinner" />
      </div>
    </div>

    <div
      class="preview-container"
      :class="{
        'preview-tablet': device === 'tablet',
        'preview-mobile': device === 'mobile',
      }"
    >
      <iframe
        ref="iframeRef"
        class="preview-iframe"
        title="FTML / SCP-CN 预览"
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'

const props = defineProps<{
  html: string
  title: string
  device: 'desktop' | 'tablet' | 'mobile'
  isLoading: boolean
  renderSummary: string
}>()

const iframeRef = ref<HTMLIFrameElement | null>(null)
let iframeReady = false

// Build preview skeleton HTML
function buildPreviewSkeletonHtml(): string {
  const CLOUDFRONT_REV = 'v--edac79f846ba'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>FTML 预览</title>
  <meta http-equiv="content-language" content="zh,zh-cn" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="https://d3g0gp89917ko0.cloudfront.net/${CLOUDFRONT_REV}/common--theme/base/css/style.css" />
  <link rel="stylesheet" href="https://d3g0gp89917ko0.cloudfront.net/${CLOUDFRONT_REV}/common--modules/css/pagerate/PageRateWidgetModule.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/scp-cn-tech/sigma9@cn/fonts/font-bauhaus.css" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/earlyaccess/nanumgothic.css" />
  <link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/font-awesome/4.3.0/css/font-awesome.min.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/scp-cn-tech/sigma9@cn/modules/colstyle.min.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/scp-cn-tech/sigma9@cn/cn/sigma9_ch.min.css" />
  <style>
    body { margin: 0; padding: 0; background: #ffffff; }
    #container-wrap { max-width: none; }
    #content { max-width: none; width: 100%; margin: 0; }
    #side-bar { display: none !important; }
    #main-content { margin-left: 0 !important; padding: 1em 1.5em; min-height: 100vh; }
    #page-title { margin-top: 0.5em; }
    .ftml-error {
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 13px;
      color: #b91c1c;
      background: #fee2e2;
      padding: 0.55rem 0.7rem;
      border-radius: 5px;
      border: 1px solid #fecaca;
      white-space: pre-wrap;
    }
    .ftml-preview-disabled { opacity: 0.7; pointer-events: none; }
    .wj-collapsible summary { list-style: none; cursor: pointer; user-select: none; }
  </style>
</head>
<body>
  <div id="container-wrap">
    <div id="header">
      <h1 id="header-title"><a href="#">SCP 基金会</a></h1>
      <h2 id="header-subtitle">Secure, Contain, Protect</h2>
    </div>
    <div id="content-wrap">
      <div id="content">
        <div id="main-content">
          <div id="page-title">FTML 预览</div>
          <div id="page-content"></div>
        </div>
      </div>
    </div>
  </div>
  <script>
    (function() {
      function runScripts(container) {
        if (!container) return;
        var scripts = container.querySelectorAll("script");
        scripts.forEach(function(oldScript) {
          var s = document.createElement("script");
          Array.from(oldScript.attributes).forEach(function(attr) {
            s.setAttribute(attr.name, attr.value);
          });
          s.text = oldScript.textContent || "";
          oldScript.parentNode.replaceChild(s, oldScript);
        });
      }
      function setupPreviewInteractions() {
        var pageContent = document.getElementById("page-content");
        if (!pageContent) return;
        var links = pageContent.querySelectorAll("a[href]");
        links.forEach(function(a) {
          var href = a.getAttribute("href") || "";
          if (href.charAt(0) === "#") return;
          if (href.toLowerCase().startsWith("javascript:")) return;
          if (a.getAttribute("target")) return;
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noreferrer noopener");
        });
      }
      function applyUpdate(msg) {
        var title = (msg && msg.title) ? String(msg.title) : "FTML 预览";
        var html = (msg && msg.html) ? String(msg.html) : "";
        var pageTitleEl = document.getElementById("page-title");
        var pageContentEl = document.getElementById("page-content");
        if (pageTitleEl) pageTitleEl.textContent = title;
        if (pageContentEl) {
          pageContentEl.innerHTML = html;
          runScripts(pageContentEl);
        }
        setupPreviewInteractions();
      }
      window.addEventListener("message", function(ev) {
        var msg = ev && ev.data;
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "ftml-update") {
          applyUpdate(msg);
        }
      });
      window.__ftmlApplyUpdate = applyUpdate;
      setupPreviewInteractions();
    })();
  <\/script>
</body>
</html>`
}

// Initialize iframe
function initIframe() {
  if (!iframeRef.value) return
  iframeRef.value.srcdoc = buildPreviewSkeletonHtml()
  iframeReady = true
}

// Update preview content via postMessage
function updatePreview(title: string, html: string) {
  if (!iframeRef.value?.contentWindow) return
  try {
    iframeRef.value.contentWindow.postMessage(
      { type: 'ftml-update', title, html },
      '*'
    )
  } catch (e) {
    console.warn('[FtmlPreview] postMessage failed:', e)
    // Reinitialize iframe on error
    initIframe()
  }
}

// Watch for html changes
watch(
  () => [props.html, props.title],
  ([html, title]) => {
    if (iframeReady) {
      updatePreview(title as string, html as string)
    }
  },
  { immediate: true }
)

onMounted(() => {
  initIframe()
  // Initial update after iframe loads
  setTimeout(() => {
    updatePreview(props.title, props.html)
  }, 100)
})

// Expose reset method
defineExpose({
  reset: () => {
    iframeReady = false
    initIframe()
    setTimeout(() => {
      updatePreview(props.title, props.html)
    }, 100)
  },
})
</script>

<style scoped>
.preview-pane {
  @apply flex flex-col h-full;
  @apply bg-white dark:bg-neutral-900;
}

.pane-header {
  @apply flex items-center justify-between px-4 py-2.5;
  @apply bg-neutral-50 dark:bg-neutral-800/50;
  @apply border-b border-neutral-200 dark:border-neutral-700;
}

.pane-title {
  @apply flex items-center gap-2 font-semibold text-neutral-800 dark:text-neutral-100;
}

.pane-icon {
  @apply text-base opacity-70;
}

.pane-stats {
  @apply text-xs text-neutral-500 dark:text-neutral-400 font-mono;
}

.loading-spinner {
  @apply w-4 h-4 border-2 border-sky-200 dark:border-sky-800;
  @apply border-t-sky-500 rounded-full animate-spin;
}

.preview-container {
  @apply flex-1 min-h-0 overflow-hidden;
  @apply flex justify-center items-stretch;
  @apply bg-white;
}

.preview-iframe {
  @apply w-full h-full border-none;
  background: #ffffff;
}

/* Device simulation */
.preview-tablet {
  @apply p-4 bg-neutral-100 dark:bg-neutral-800;
}

.preview-tablet .preview-iframe {
  @apply w-[768px] max-w-full rounded-xl shadow-lg;
  @apply border border-neutral-200 dark:border-neutral-700;
}

.preview-mobile {
  @apply p-4 bg-neutral-100 dark:bg-neutral-800;
}

.preview-mobile .preview-iframe {
  @apply w-[390px] max-w-full rounded-xl shadow-lg;
  @apply border border-neutral-200 dark:border-neutral-700;
}
</style>
