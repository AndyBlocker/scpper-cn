<template>
  <div class="ds-page">
    <!-- Ambient Background -->
    <div class="ambient-bg">
      <div class="glow glow-1"></div>
      <div class="glow glow-2"></div>
      <div class="glow glow-3"></div>
      <div class="noise-layer"></div>
    </div>

    <!-- Navigation -->
    <nav class="nav-bar">
      <div class="nav-inner">
        <div class="nav-brand">
          <div class="brand-mark">
            <BrandIcon class="w-5 h-5" />
          </div>
          <div class="brand-text">
            <span class="brand-name">SCPPER</span>
            <span class="brand-tag">CN</span>
          </div>
        </div>

        <div class="nav-center">
          <a v-for="item in navItems" :key="item.id" :href="'#' + item.id" class="nav-link">
            {{ item.label }}
          </a>
        </div>

        <div class="nav-actions">
          <!-- Theme Switcher -->
          <div class="theme-pills">
            <button
              v-for="scheme in colorSchemes"
              :key="scheme.id"
              @click="setColorScheme(scheme.id)"
              class="theme-pill"
              :class="{ active: currentScheme === scheme.id }"
              :style="{ '--pill-color': scheme.color }"
              :title="scheme.name"
            >
              <span class="pill-dot"></span>
            </button>
          </div>

          <button @click="toggleTheme" class="mode-toggle" :title="isDark ? '浅色模式' : '深色模式'">
            <LucideIcon :name="isDark ? 'Sun' : 'Moon'" class="w-4 h-4" />
          </button>
        </div>
      </div>
    </nav>

    <!-- Main Content -->
    <div class="main-layout">
      <!-- Sidebar Navigation (Desktop) -->
      <aside class="sidebar">
        <div class="sidebar-inner">
          <div class="sidebar-header">
            <span class="sidebar-label">目录</span>
          </div>
          <nav class="sidebar-nav">
            <a
              v-for="(item, index) in navItems"
              :key="item.id"
              :href="'#' + item.id"
              class="sidebar-link"
              :class="{ active: activeSection === item.id }"
            >
              <span class="link-num">{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="link-text">{{ item.label }}</span>
            </a>
          </nav>
          <div class="sidebar-stats">
            <div class="mini-stat">
              <span class="mini-stat-value">10</span>
              <span class="mini-stat-label">章节</span>
            </div>
            <div class="mini-stat">
              <span class="mini-stat-value">50+</span>
              <span class="mini-stat-label">组件</span>
            </div>
          </div>
        </div>
      </aside>

      <main class="main-content">
      <!-- Hero Section -->
      <header class="hero-section">
        <div class="hero-badge">
          <span class="badge-dot"></span>
          <span>Design System v3.0</span>
        </div>
        <h1 class="hero-title">
          <span class="title-line">设计系统</span>
          <span class="title-line title-accent">组件样本</span>
        </h1>
        <p class="hero-desc">
          SCPPER-CN 前端视觉规范参考。温暖、现代、精致的数据展示体验。
        </p>
        <div class="hero-stats">
          <div class="hero-stat">
            <span class="stat-num">10</span>
            <span class="stat-label">章节</span>
          </div>
          <div class="hero-stat">
            <span class="stat-num">50+</span>
            <span class="stat-label">组件</span>
          </div>
          <div class="hero-stat">
            <span class="stat-num">8</span>
            <span class="stat-label">主题</span>
          </div>
        </div>
      </header>

      <!-- Section: Colors -->
      <section id="colors" class="ds-section">
        <SectionHead title="色彩系统" subtitle="Color System" num="01" />

        <div class="section-body">
          <div class="color-grid">
            <!-- Primary Accent -->
            <div class="color-card color-card-hero">
              <div class="color-preview" style="background: linear-gradient(135deg, rgb(var(--accent)), rgb(var(--accent-strong)))">
                <span class="color-name">Accent</span>
              </div>
              <div class="color-meta">
                <span class="color-var">--accent</span>
                <span class="color-desc">主题色</span>
              </div>
            </div>

            <!-- Base Colors -->
            <div class="color-card">
              <div class="color-preview" style="background: rgb(var(--bg))">
                <span class="color-name dark-text">Background</span>
              </div>
              <div class="color-meta">
                <span class="color-var">--bg</span>
              </div>
            </div>

            <div class="color-card">
              <div class="color-preview" style="background: rgb(var(--panel))">
                <span class="color-name dark-text">Panel</span>
              </div>
              <div class="color-meta">
                <span class="color-var">--panel</span>
              </div>
            </div>

            <div class="color-card">
              <div class="color-preview" style="background: rgb(var(--fg))">
                <span class="color-name">Foreground</span>
              </div>
              <div class="color-meta">
                <span class="color-var">--fg</span>
              </div>
            </div>

            <!-- Semantic -->
            <div class="color-card">
              <div class="color-preview" style="background: rgb(var(--success))">
                <span class="color-name">Success</span>
              </div>
              <div class="color-meta">
                <span class="color-var">--success</span>
              </div>
            </div>

            <div class="color-card">
              <div class="color-preview" style="background: rgb(var(--danger))">
                <span class="color-name">Danger</span>
              </div>
              <div class="color-meta">
                <span class="color-var">--danger</span>
              </div>
            </div>
          </div>

          <!-- Gradient Showcase -->
          <div class="gradient-showcase">
            <div class="gradient-item" style="background: linear-gradient(135deg, #ff9a56 0%, #ff6b6b 50%, #ee5a9a 100%)">
              <span>Sunset</span>
            </div>
            <div class="gradient-item" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%)">
              <span>Violet</span>
            </div>
            <div class="gradient-item" style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%)">
              <span>Rose</span>
            </div>
            <div class="gradient-item" style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)">
              <span>Ocean</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Section: Typography -->
      <section id="typography" class="ds-section">
        <SectionHead title="排版系统" subtitle="Typography" num="02" />

        <div class="section-body">
          <div class="glass-card">
            <div class="typo-showcase">
              <div class="typo-item">
                <span class="typo-sample text-5xl font-bold">Aa 中文</span>
                <span class="typo-meta">Display / 5xl / Bold</span>
              </div>
              <div class="typo-item">
                <span class="typo-sample text-3xl font-semibold">标题文字 Heading</span>
                <span class="typo-meta">Heading / 3xl / Semibold</span>
              </div>
              <div class="typo-item">
                <span class="typo-sample text-xl">正文内容 Body Text</span>
                <span class="typo-meta">Body / xl / Regular</span>
              </div>
              <div class="typo-item">
                <span class="typo-sample text-sm text-[rgb(var(--muted))]">辅助说明文字 Caption</span>
                <span class="typo-meta">Caption / sm / Muted</span>
              </div>
            </div>

            <div class="typo-numbers">
              <div class="number-display">
                <span class="number-value">12,345</span>
                <span class="number-label">总页面数</span>
              </div>
              <div class="number-display">
                <span class="number-value accent">+892</span>
                <span class="number-label">本周新增</span>
              </div>
              <div class="number-display">
                <span class="number-value danger">-23</span>
                <span class="number-label">已删除</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Section: Buttons -->
      <section id="buttons" class="ds-section">
        <SectionHead title="交互组件" subtitle="Interactions" num="03" />

        <div class="section-body">
          <div class="glass-card">
            <h4 class="card-subtitle">按钮 / Buttons</h4>
            <div class="button-grid">
              <button class="btn btn-primary">
                <LucideIcon name="Plus" class="w-4 h-4" />
                <span>主要操作</span>
              </button>
              <button class="btn btn-secondary">次要操作</button>
              <button class="btn btn-ghost">文字按钮</button>
              <button class="btn btn-danger">
                <LucideIcon name="Trash2" class="w-4 h-4" />
                <span>删除</span>
              </button>
            </div>

            <div class="button-grid mt-4">
              <button class="btn btn-primary btn-sm">小按钮</button>
              <button class="btn btn-secondary btn-sm">小按钮</button>
              <button class="btn btn-icon">
                <LucideIcon name="Heart" class="w-4 h-4" />
              </button>
              <button class="btn btn-icon">
                <LucideIcon name="Bookmark" class="w-4 h-4" />
              </button>
              <button class="btn btn-icon">
                <LucideIcon name="Share2" class="w-4 h-4" />
              </button>
            </div>
          </div>

          <div class="glass-card">
            <h4 class="card-subtitle">表单 / Forms</h4>
            <div class="form-grid">
              <div class="form-field">
                <label class="field-label">搜索</label>
                <div class="input-wrapper">
                  <LucideIcon name="Search" class="input-icon" />
                  <input type="text" class="input-text" placeholder="输入关键词..." />
                </div>
              </div>

              <div class="form-field">
                <label class="field-label">选择排序</label>
                <select class="input-select">
                  <option>按评分排序</option>
                  <option>按时间排序</option>
                  <option>按热度排序</option>
                </select>
              </div>
            </div>

            <div class="chip-group">
              <button class="chip active">全部</button>
              <button class="chip">SCP</button>
              <button class="chip">故事</button>
              <button class="chip">艺术作品</button>
              <button class="chip">GOI格式</button>
            </div>
          </div>
        </div>
      </section>

      <!-- Section: Cards -->
      <section id="cards" class="ds-section">
        <SectionHead title="页面卡片" subtitle="Page Cards" num="04" />

        <div class="section-body">
          <!-- Featured Card -->
          <div class="page-card page-card-featured">
            <div class="card-glow"></div>
            <div class="card-content">
              <div class="card-header">
                <div class="card-badges">
                  <span class="badge badge-premium">
                    <LucideIcon name="Award" class="w-3 h-3" />
                    精品
                  </span>
                  <span class="badge badge-vote-up">+128</span>
                </div>
                <span class="card-date">2024-12-15</span>
              </div>

              <h3 class="card-title">SCP-CN-001: 等待解密</h3>

              <p class="card-excerpt">
                本文档包含了基金会对于中国分部第一号特殊收容程序的完整记录。由于其高度机密性质，访问受到严格限制...
              </p>

              <div class="card-author">
                <UserAvatar :wikidot-id="123456" :size="28" name="AndyBlocker" />
                <div class="author-info">
                  <span class="author-name">AndyBlocker</span>
                  <span class="author-meta">Level 4 · 42 作品</span>
                </div>
              </div>

              <div class="card-tags">
                <span class="tag">#scp</span>
                <span class="tag">#cn</span>
                <span class="tag">#001提案</span>
                <span class="tag">+3</span>
              </div>

              <div class="card-stats">
                <div class="stat-item">
                  <LucideIcon name="ThumbsUp" class="w-4 h-4" />
                  <span>128</span>
                </div>
                <div class="stat-item">
                  <LucideIcon name="MessageCircle" class="w-4 h-4" />
                  <span>45</span>
                </div>
                <div class="stat-item">
                  <LucideIcon name="Eye" class="w-4 h-4" />
                  <span>2.3k</span>
                </div>
              </div>

              <!-- Mini Sparkline -->
              <div class="card-sparkline">
                <svg viewBox="0 0 100 24" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stop-color="rgb(var(--accent))" stop-opacity="0.3" />
                      <stop offset="100%" stop-color="rgb(var(--accent))" stop-opacity="0" />
                    </linearGradient>
                  </defs>
                  <path d="M0,20 Q10,18 20,15 T40,12 T60,8 T80,10 T100,6 L100,24 L0,24 Z" fill="url(#spark-fill)" />
                  <path d="M0,20 Q10,18 20,15 T40,12 T60,8 T80,10 T100,6" fill="none" stroke="rgb(var(--accent))" stroke-width="2" stroke-linecap="round" />
                </svg>
              </div>
            </div>
          </div>

          <!-- Card Grid - Medium Size -->
          <h4 class="card-grid-title">中等卡片 / Medium Cards</h4>
          <div class="card-grid card-grid-2">
            <div class="page-card page-card-md">
              <div class="card-content">
                <div class="card-header">
                  <div class="card-badges">
                    <span class="badge badge-vote-up">+56</span>
                    <span class="badge badge-tracking">
                      <LucideIcon name="Bell" class="w-3 h-3" />
                      追踪
                    </span>
                  </div>
                  <span class="card-date">2024-12-10</span>
                </div>
                <h3 class="card-title">SCP-CN-002: 永恒火焰</h3>
                <p class="card-excerpt">一团永不熄灭的火焰，任何尝试扑灭它的行为都会导致火焰温度急剧上升...</p>
                <div class="card-author">
                  <UserAvatar :wikidot-id="789" :size="24" name="Researcher" />
                  <div class="author-info">
                    <span class="author-name">Researcher_J</span>
                    <span class="author-meta">23 作品</span>
                  </div>
                </div>
                <div class="card-footer">
                  <div class="card-tags">
                    <span class="tag">#scp</span>
                    <span class="tag">#euclid</span>
                    <span class="tag">+2</span>
                  </div>
                  <div class="card-stats-mini">
                    <span><LucideIcon name="ThumbsUp" class="w-3 h-3" /> 56</span>
                    <span><LucideIcon name="MessageCircle" class="w-3 h-3" /> 12</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="page-card page-card-md">
              <div class="card-content">
                <div class="card-header">
                  <div class="card-badges">
                    <span class="badge badge-vote-down">-8</span>
                  </div>
                  <span class="card-date">2024-12-08</span>
                </div>
                <h3 class="card-title">SCP-CN-003: 镜中世界</h3>
                <p class="card-excerpt">一面古董镜子，任何注视它超过30秒的人都会看到镜中的另一个自己...</p>
                <div class="card-author">
                  <UserAvatar :wikidot-id="456" :size="24" name="Author" />
                  <div class="author-info">
                    <span class="author-name">Author_X</span>
                    <span class="author-meta">5 作品</span>
                  </div>
                </div>
                <div class="card-footer">
                  <div class="card-tags">
                    <span class="tag">#scp</span>
                    <span class="tag">#safe</span>
                  </div>
                  <div class="card-stats-mini">
                    <span><LucideIcon name="ThumbsUp" class="w-3 h-3" /> -8</span>
                    <span><LucideIcon name="MessageCircle" class="w-3 h-3" /> 5</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Card Grid - Small Size -->
          <h4 class="card-grid-title">小型卡片 / Small Cards</h4>
          <div class="card-grid card-grid-3">
            <div class="page-card page-card-sm">
              <div class="card-content">
                <div class="card-header">
                  <span class="badge badge-vote-up">+32</span>
                  <span class="card-date">12-05</span>
                </div>
                <h3 class="card-title">SCP-CN-005: 永恒笔记</h3>
                <div class="card-author">
                  <UserAvatar :wikidot-id="111" :size="20" name="Writer" />
                  <span class="author-name">Writer_A</span>
                </div>
              </div>
            </div>

            <div class="page-card page-card-sm">
              <div class="card-content">
                <div class="card-header">
                  <span class="badge badge-vote-up">+18</span>
                  <span class="card-date">12-03</span>
                </div>
                <h3 class="card-title">SCP-CN-006: 回声走廊</h3>
                <div class="card-author">
                  <UserAvatar :wikidot-id="222" :size="20" name="Contributor" />
                  <span class="author-name">Contributor_B</span>
                </div>
              </div>
            </div>

            <div class="page-card page-card-sm page-card-deleted">
              <div class="card-content">
                <div class="card-header">
                  <span class="badge badge-deleted">已删除</span>
                  <span class="card-date">12-01</span>
                </div>
                <h3 class="card-title deleted">SCP-CN-007: [数据删除]</h3>
                <div class="card-author">
                  <UserAvatar :size="20" name="Unknown" />
                  <span class="author-name muted">未知</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Section: User Cards -->
      <section id="users" class="ds-section">
        <SectionHead title="用户卡片" subtitle="User Cards" num="05" />

        <div class="section-body">
          <div class="user-grid">
            <!-- Featured User -->
            <div class="user-card user-card-featured">
              <div class="user-rank">#1</div>
              <div class="user-avatar-wrapper">
                <UserAvatar :wikidot-id="123456" :size="72" name="AndyBlocker" class="user-avatar-lg" />
                <div class="avatar-glow"></div>
              </div>
              <h3 class="user-name">AndyBlocker</h3>
              <span class="user-title">资深贡献者</span>

              <div class="user-stats">
                <div class="user-stat">
                  <span class="stat-value">42</span>
                  <span class="stat-label">作品</span>
                </div>
                <div class="user-stat highlight">
                  <span class="stat-value">1,280</span>
                  <span class="stat-label">总评分</span>
                </div>
                <div class="user-stat">
                  <span class="stat-value">98%</span>
                  <span class="stat-label">UpVote率</span>
                </div>
              </div>

              <div class="user-trend">
                <svg viewBox="0 0 120 32" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="user-trend-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stop-color="rgb(var(--success))" stop-opacity="0.2" />
                      <stop offset="100%" stop-color="rgb(var(--success))" stop-opacity="0" />
                    </linearGradient>
                  </defs>
                  <path d="M0,28 L15,24 L30,26 L45,20 L60,18 L75,14 L90,10 L105,12 L120,6 L120,32 L0,32 Z" fill="url(#user-trend-fill)" />
                  <path d="M0,28 L15,24 L30,26 L45,20 L60,18 L75,14 L90,10 L105,12 L120,6" fill="none" stroke="rgb(var(--success))" stroke-width="2" stroke-linecap="round" />
                </svg>
                <span class="trend-label">
                  <LucideIcon name="TrendingUp" class="w-3 h-3" />
                  +12% 本月
                </span>
              </div>
            </div>

            <!-- Regular User Cards -->
            <div class="user-card">
              <div class="user-card-inner">
                <UserAvatar :wikidot-id="789" :size="48" name="Researcher" />
                <div class="user-info">
                  <h4 class="user-name">Researcher_J</h4>
                  <span class="user-meta">56 作品 · 评分 890</span>
                </div>
                <div class="user-badge">#12</div>
              </div>
            </div>

            <div class="user-card">
              <div class="user-card-inner">
                <UserAvatar :wikidot-id="456" :size="48" name="Writer" />
                <div class="user-info">
                  <h4 class="user-name">Writer_K</h4>
                  <span class="user-meta">34 作品 · 评分 567</span>
                </div>
                <div class="user-badge">#23</div>
              </div>
            </div>
          </div>

          <!-- User Chips -->
          <div class="glass-card">
            <h4 class="card-subtitle">用户标签 / User Chips</h4>
            <div class="user-chips">
              <div class="user-chip">
                <UserAvatar :wikidot-id="123" :size="20" name="A" />
                <span>Author_A</span>
              </div>
              <div class="user-chip">
                <UserAvatar :wikidot-id="456" :size="20" name="B" />
                <span>Author_B</span>
              </div>
              <div class="user-chip">
                <UserAvatar :wikidot-id="789" :size="20" name="长名称" />
                <span>长名称用户</span>
              </div>
              <div class="user-chip user-chip-add">
                <LucideIcon name="Plus" class="w-3 h-3" />
                <span>添加</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Section: Data Display -->
      <section id="data" class="ds-section">
        <SectionHead title="数据展示" subtitle="Data Display" num="06" />

        <div class="section-body">
          <!-- KPI Cards -->
          <div class="kpi-grid">
            <div class="kpi-card">
              <div class="kpi-header">
                <span class="kpi-label">总页面数</span>
                <div class="kpi-indicator active"></div>
              </div>
              <div class="kpi-value">12,345</div>
              <div class="kpi-trend up">
                <LucideIcon name="TrendingUp" class="w-3 h-3" />
                <span>+12.5%</span>
                <span class="trend-period">较上周</span>
              </div>
            </div>

            <div class="kpi-card">
              <div class="kpi-header">
                <span class="kpi-label">活跃用户</span>
                <div class="kpi-indicator active"></div>
              </div>
              <div class="kpi-value">8,920</div>
              <div class="kpi-trend up">
                <LucideIcon name="TrendingUp" class="w-3 h-3" />
                <span>+5.2%</span>
                <span class="trend-period">较上周</span>
              </div>
            </div>

            <div class="kpi-card">
              <div class="kpi-header">
                <span class="kpi-label">平均评分</span>
                <div class="kpi-indicator"></div>
              </div>
              <div class="kpi-value">98.4</div>
              <div class="kpi-trend down">
                <LucideIcon name="TrendingDown" class="w-3 h-3" />
                <span>-0.4%</span>
                <span class="trend-period">较上周</span>
              </div>
            </div>

            <div class="kpi-card">
              <div class="kpi-header">
                <span class="kpi-label">当前在线</span>
                <div class="kpi-indicator active pulse"></div>
              </div>
              <div class="kpi-value">450</div>
              <div class="kpi-trend up">
                <LucideIcon name="TrendingUp" class="w-3 h-3" />
                <span>+8.1%</span>
                <span class="trend-period">较昨日</span>
              </div>
            </div>
          </div>

          <!-- Chart Area -->
          <div class="glass-card chart-card">
            <div class="chart-header">
              <h4 class="card-subtitle">评分趋势 / Rating Trend</h4>
              <div class="chart-controls">
                <button class="chart-btn active">周</button>
                <button class="chart-btn">月</button>
                <button class="chart-btn">年</button>
              </div>
            </div>
            <div class="chart-placeholder">
              <div class="chart-bars">
                <div class="chart-bar" style="--h: 60%"><span>Mon</span></div>
                <div class="chart-bar" style="--h: 80%"><span>Tue</span></div>
                <div class="chart-bar" style="--h: 45%"><span>Wed</span></div>
                <div class="chart-bar" style="--h: 90%"><span>Thu</span></div>
                <div class="chart-bar" style="--h: 70%"><span>Fri</span></div>
                <div class="chart-bar active" style="--h: 85%"><span>Sat</span></div>
                <div class="chart-bar" style="--h: 55%"><span>Sun</span></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Section: Badges -->
      <section id="badges" class="ds-section">
        <SectionHead title="徽章状态" subtitle="Badges & States" num="07" />

        <div class="section-body">
          <div class="glass-card">
            <h4 class="card-subtitle">投票徽章 / Vote Badges</h4>
            <div class="badge-group">
              <span class="badge badge-vote-up">+128</span>
              <span class="badge badge-vote-up">+1</span>
              <span class="badge badge-vote-down">-1</span>
              <span class="badge badge-vote-down">-23</span>
              <span class="badge badge-neutral">0</span>
            </div>

            <h4 class="card-subtitle mt-6">状态徽章 / Status Badges</h4>
            <div class="badge-group">
              <span class="badge badge-premium">
                <LucideIcon name="Award" class="w-3 h-3" />
                精品
              </span>
              <span class="badge badge-tracking">
                <LucideIcon name="Bell" class="w-3 h-3" />
                追踪中
              </span>
              <span class="badge badge-deleted">已删除</span>
              <span class="badge badge-new">NEW</span>
            </div>

            <h4 class="card-subtitle mt-6">状态指示 / Status Indicators</h4>
            <div class="badge-group">
              <span class="status-pill status-success">
                <span class="status-dot"></span>
                运行正常
              </span>
              <span class="status-pill status-warning">
                <span class="status-dot"></span>
                需要注意
              </span>
              <span class="status-pill status-danger">
                <span class="status-dot"></span>
                收容失效
              </span>
              <span class="status-pill status-processing">
                <span class="status-dot"></span>
                处理中
              </span>
            </div>
          </div>

          <div class="glass-card">
            <h4 class="card-subtitle">标签 / Tags</h4>
            <div class="tag-cloud">
              <span class="tag">#scp</span>
              <span class="tag">#euclid</span>
              <span class="tag">#keter</span>
              <span class="tag">#safe</span>
              <span class="tag tag-active">#featured</span>
              <span class="tag">#antimemetic</span>
              <span class="tag">#foundation</span>
              <span class="tag">#tale</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Section: Notifications -->
      <section id="notifications" class="ds-section">
        <SectionHead title="通知组件" subtitle="Notifications" num="08" />

        <div class="section-body">
          <div class="notification-grid">
            <!-- Notification Panel -->
            <div class="notification-panel">
              <div class="panel-header">
                <h4>通知</h4>
                <button class="link-btn">全部已读</button>
              </div>
              <div class="notification-list">
                <div class="notification-item unread">
                  <div class="notif-icon success">
                    <LucideIcon name="TrendingUp" class="w-4 h-4" />
                  </div>
                  <div class="notif-content">
                    <p class="notif-title">SCP-CN-001 评分上升</p>
                    <p class="notif-meta">评分变动 <strong class="text-[rgb(var(--success))]">+5</strong> · 当前 128</p>
                  </div>
                  <span class="notif-time">2小时前</span>
                </div>
                <div class="notification-item">
                  <div class="notif-icon info">
                    <LucideIcon name="MessageCircle" class="w-4 h-4" />
                  </div>
                  <div class="notif-content">
                    <p class="notif-title">新评论</p>
                    <p class="notif-meta">Researcher_J 评论了你的作品</p>
                  </div>
                  <span class="notif-time">5小时前</span>
                </div>
                <div class="notification-item">
                  <div class="notif-icon warning">
                    <LucideIcon name="AlertTriangle" class="w-4 h-4" />
                  </div>
                  <div class="notif-content">
                    <p class="notif-title">评分警告</p>
                    <p class="notif-meta">SCP-CN-003 评分低于阈值</p>
                  </div>
                  <span class="notif-time">1天前</span>
                </div>
              </div>
              <a href="#" class="panel-footer">查看全部通知</a>
            </div>

            <!-- Search Dropdown -->
            <div class="search-panel">
              <div class="search-input-wrapper">
                <LucideIcon name="Search" class="w-4 h-4" />
                <input type="text" placeholder="搜索页面、用户..." value="SCP-CN" />
                <kbd>⌘K</kbd>
              </div>
              <div class="search-results">
                <div class="search-group">
                  <span class="group-label">页面</span>
                  <a href="#" class="search-result active">
                    <div class="result-info">
                      <span class="result-title">SCP-CN-001</span>
                      <span class="result-meta">等待解密 · +128</span>
                    </div>
                    <span class="result-type">页面</span>
                  </a>
                  <a href="#" class="search-result">
                    <div class="result-info">
                      <span class="result-title">SCP-CN-002</span>
                      <span class="result-meta">永恒火焰 · +56</span>
                    </div>
                    <span class="result-type">页面</span>
                  </a>
                </div>
                <div class="search-group">
                  <span class="group-label">用户</span>
                  <a href="#" class="search-result">
                    <div class="result-info">
                      <span class="result-title">CN_Author</span>
                      <span class="result-meta">12 作品 · 评分 234</span>
                    </div>
                    <span class="result-type">用户</span>
                  </a>
                </div>
              </div>
            </div>
          </div>

          <!-- Alert Messages -->
          <div class="alert-stack">
            <div class="alert alert-info">
              <LucideIcon name="Info" class="w-5 h-5" />
              <div class="alert-content">
                <strong>系统通知</strong>
                <p>新的权限等级已生效，请刷新页面查看更新。</p>
              </div>
              <button class="alert-close">
                <LucideIcon name="X" class="w-4 h-4" />
              </button>
            </div>
            <div class="alert alert-success">
              <LucideIcon name="CheckCircle" class="w-5 h-5" />
              <div class="alert-content">
                <strong>操作成功</strong>
                <p>你的作品已成功发布。</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Section: Effects -->
      <section id="effects" class="ds-section">
        <SectionHead title="视觉效果" subtitle="Visual Effects" num="09" />

        <div class="section-body">
          <div class="effects-grid">
            <div class="effect-card">
              <h4 class="effect-title">毛玻璃 / Glassmorphism</h4>
              <div class="glass-demo">
                <div class="glass-layer"></div>
                <span>backdrop-blur + transparency</span>
              </div>
            </div>

            <div class="effect-card">
              <h4 class="effect-title">光晕 / Glow Effect</h4>
              <div class="glow-demo">
                <div class="glow-orb"></div>
                <span>Radial gradient + blur</span>
              </div>
            </div>

            <div class="effect-card">
              <h4 class="effect-title">渐变 / Gradient</h4>
              <div class="gradient-demo">
                <div class="gradient-layer"></div>
                <span>Linear gradient overlay</span>
              </div>
            </div>

            <div class="effect-card">
              <h4 class="effect-title">噪点 / Noise Texture</h4>
              <div class="noise-demo">
                <div class="noise-texture"></div>
                <span>SVG noise filter</span>
              </div>
            </div>
          </div>

          <!-- Animation Showcase -->
          <div class="glass-card">
            <h4 class="card-subtitle">动画 / Animations</h4>
            <div class="animation-grid">
              <div class="anim-item">
                <div class="anim-box pulse-anim"></div>
                <span>Pulse</span>
              </div>
              <div class="anim-item">
                <div class="anim-box float-anim"></div>
                <span>Float</span>
              </div>
              <div class="anim-item">
                <div class="anim-box spin-anim"></div>
                <span>Spin</span>
              </div>
              <div class="anim-item">
                <div class="anim-box shimmer-anim"></div>
                <span>Shimmer</span>
              </div>
            </div>
          </div>

          <!-- Loading States -->
          <div class="glass-card">
            <h4 class="card-subtitle">加载状态 / Loading States</h4>
            <div class="loading-grid">
              <div class="skeleton-card">
                <div class="skeleton skeleton-avatar"></div>
                <div class="skeleton-content">
                  <div class="skeleton skeleton-title"></div>
                  <div class="skeleton skeleton-text"></div>
                  <div class="skeleton skeleton-text short"></div>
                </div>
              </div>
              <div class="loading-spinner">
                <div class="spinner"></div>
                <span>加载中...</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Section: CSS Reference -->
      <section id="reference" class="ds-section">
        <SectionHead title="样式参考" subtitle="CSS Reference" num="10" />

        <div class="section-body">
          <div class="glass-card code-card">
            <div class="code-header">
              <span class="code-lang">CSS Variables</span>
              <button class="copy-btn">
                <LucideIcon name="Copy" class="w-4 h-4" />
                复制
              </button>
            </div>
            <pre class="code-block"><code>/* ========== 基础色彩 ========== */
--bg: 250 250 252;              /* 页面背景 */
--fg: 23 23 23;                 /* 主要文本 */
--panel: 255 255 255;           /* 卡片背景 */
--panel-border: 235 235 240;    /* 边框颜色 */

/* ========== 文本层次 ========== */
--muted: 130 130 140;           /* 次要文本 */
--muted-strong: 80 80 90;       /* 强调次要文本 */

/* ========== 主题色 (暖色调) ========== */
--accent: 255 140 90;           /* 主要强调色 */
--accent-strong: 240 100 60;    /* 深强调色 */
--accent-weak: 255 200 170;     /* 浅强调色 */

/* ========== 语义色彩 ========== */
--success: 52 199 89;           /* 成功/正向 */
--success-strong: 40 167 69;
--danger: 255 59 48;            /* 危险/负向 */
--danger-strong: 220 53 69;
--warning: 255 149 0;           /* 警告 */

/* ========== 特效 ========== */
--glow-color: 255 140 90;       /* 光晕颜色 */
--glass-bg: 255 255 255 / 0.7;  /* 毛玻璃背景 */
--glass-border: 255 255 255 / 0.3;

/* ========== 深色模式 ========== */
html.dark {
  --bg: 18 18 22;
  --fg: 250 250 252;
  --panel: 28 28 35;
  --panel-border: 45 45 55;
  --muted: 140 140 155;
  --glass-bg: 35 35 45 / 0.7;
}</code></pre>
          </div>
        </div>
      </section>

      <!-- Footer -->
      <footer class="ds-footer">
        <div class="footer-content">
          <BrandIcon class="w-6 h-6 opacity-30" />
          <p>SCPPER-CN Design System v3.0</p>
          <p class="footer-sub">Built with Vue 3 + Tailwind CSS</p>
        </div>
      </footer>
    </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, h, onMounted, onUnmounted } from 'vue'

// Active section tracking
const activeSection = ref('colors')

// Components
const SectionHead = (props: { title: string; subtitle: string; num: string }) => {
  return h('div', { class: 'section-head' }, [
    h('div', { class: 'section-titles' }, [
      h('span', { class: 'section-num' }, props.num),
      h('div', [
        h('h2', { class: 'section-title' }, props.title),
        h('p', { class: 'section-subtitle' }, props.subtitle)
      ])
    ]),
    h('div', { class: 'section-line' })
  ])
}

// Data
const navItems = [
  { id: 'colors', label: '色彩' },
  { id: 'typography', label: '排版' },
  { id: 'buttons', label: '交互' },
  { id: 'cards', label: '卡片' },
  { id: 'users', label: '用户' },
  { id: 'data', label: '数据' },
  { id: 'badges', label: '徽章' },
  { id: 'notifications', label: '通知' },
  { id: 'effects', label: '效果' },
  { id: 'reference', label: '参考' },
]

const colorSchemes = [
  { id: 'amber', name: 'Amber', color: '#f59e0b' },
  { id: 'rose', name: 'Rose', color: '#f43f5e' },
  { id: 'violet', name: 'Violet', color: '#8b5cf6' },
  { id: 'sky', name: 'Sky', color: '#0ea5e9' },
  { id: 'emerald', name: 'Emerald', color: '#10b981' },
  { id: 'indigo', name: 'Indigo', color: '#6366f1' },
]

const currentScheme = ref('amber')
const isDark = ref(false)

function setColorScheme(schemeId: string) {
  currentScheme.value = schemeId
  if (typeof document !== 'undefined') {
    const html = document.documentElement
    colorSchemes.forEach(s => html.classList.remove(`scheme-${s.id}`))
    html.classList.add(`scheme-${schemeId}`)
  }
}

function toggleTheme() {
  if (typeof document !== 'undefined') {
    isDark.value = !isDark.value
    document.documentElement.classList.toggle('dark', isDark.value)
  }
}

// Scroll spy for sidebar
let scrollHandler: (() => void) | null = null

onMounted(() => {
  if (typeof document !== 'undefined') {
    isDark.value = document.documentElement.classList.contains('dark')
    // Set default warm scheme
    setColorScheme('amber')

    // Setup scroll spy
    scrollHandler = () => {
      const sections = navItems.map(item => document.getElementById(item.id)).filter(Boolean)
      const scrollY = window.scrollY + 150

      for (let i = sections.length - 1; i >= 0; i--) {
        const section = sections[i]
        if (section && section.offsetTop <= scrollY) {
          activeSection.value = navItems[i].id
          break
        }
      }
    }

    window.addEventListener('scroll', scrollHandler, { passive: true })
    scrollHandler()
  }
})

onUnmounted(() => {
  if (scrollHandler) {
    window.removeEventListener('scroll', scrollHandler)
  }
})

definePageMeta({ layout: 'default' })
</script>

<style scoped>
/* ================================================
   SCPPER-CN Design System v3.0
   Warm Modern Glass Aesthetic
   ================================================ */

/* === Base Page === */
  .ds-page {
    @apply min-h-screen relative;
    --bg: 244 240 233;
    --fg: 32 29 26;
    --muted: 114 106 97;
    --muted-strong: 82 74 66;
    --panel: 255 252 246;
    --panel-border: 120 110 100;
    --tag-bg: 247 241 233;
    --tag-border: 204 193 180;
    --tag-text: 96 88 80;
    --input-bg: 255 253 248;
    --input-border: 188 176 164;
    --accent: 214 92 64;
    --accent-strong: 172 70 50;
    --accent-weak: 244 224 209;
    --success: 52 119 93;
    --danger: 172 68 68;
    --warning: 212 156 70;
    background: rgb(var(--bg));
    background-image:
      linear-gradient(rgb(var(--fg) / 0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgb(var(--fg) / 0.05) 1px, transparent 1px);
    background-size: 26px 26px;
    color: rgb(var(--fg));
    font-family: 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
  }


/* === Ambient Background === */
.ambient-bg {
  @apply fixed inset-0 pointer-events-none overflow-hidden;
  z-index: 0;
}

  .glow {
    @apply absolute rounded-full blur-[140px] opacity-20;
    background: radial-gradient(circle, rgb(var(--accent) / 0.12), transparent 70%);
    mix-blend-mode: multiply;
  }


.glow-1 {
  @apply w-[520px] h-[520px] -top-40 -right-40;
  animation: float 20s ease-in-out infinite;
}

.glow-2 {
  @apply w-[440px] h-[440px] top-1/3 -left-24;
  background: radial-gradient(circle, rgb(var(--accent-weak) / 0.08), transparent 70%);
  animation: float 25s ease-in-out infinite reverse;
}

.glow-3 {
  @apply w-[360px] h-[360px] bottom-0 right-1/4;
  background: radial-gradient(circle, rgb(var(--success) / 0.06), transparent 70%);
  animation: float 18s ease-in-out infinite 5s;
}

.noise-layer {
  @apply absolute inset-0 opacity-[0.03];
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.7' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
}


@keyframes float {
  0%, 100% { transform: translate(0, 0) scale(1); }
  33% { transform: translate(30px, -30px) scale(1.05); }
  66% { transform: translate(-20px, 20px) scale(0.95); }
}

/* === Navigation === */
  .nav-bar {
    @apply fixed top-0 left-0 right-0 z-50;
    background: rgb(var(--panel));
    border-bottom: 2px solid rgb(var(--panel-border));
    box-shadow: 4px 4px 0 rgb(var(--fg) / 0.6);
  }


.nav-inner {
  @apply max-w-7xl mx-auto px-6 h-16 flex items-center justify-between;
}

.nav-brand {
  @apply flex items-center gap-3;
}

  .brand-mark {
    @apply w-9 h-9 flex items-center justify-center;
    background: rgb(var(--accent));
    color: white;
    box-shadow: 3px 3px 0 rgb(var(--fg) / 0.8);
    border: 2px solid rgb(var(--fg));
    border-radius: 3px;
  }


.brand-text {
  @apply flex items-baseline gap-1;
}

.brand-name {
  @apply font-bold text-lg tracking-tight;
}

.brand-tag {
  @apply text-xs font-semibold px-1.5 py-0.5 rounded;
  background: rgb(var(--accent) / 0.1);
  color: rgb(var(--accent));
}

.nav-center {
  @apply hidden md:flex items-center gap-1;
}

  .nav-link {
    @apply px-3 py-1.5 text-sm font-medium transition-all;
    color: rgb(var(--muted));
    border-radius: 2px;
    font-family: 'Courier New', 'SFMono-Regular', monospace;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .nav-link:hover {
    color: rgb(var(--fg));
    background: rgb(var(--panel));
    box-shadow: inset 0 -2px 0 rgb(var(--accent));
  }


.nav-actions {
  @apply flex items-center gap-3;
}

.theme-pills {
  @apply flex gap-1 p-1 rounded-full;
  background: rgb(var(--fg) / 0.05);
}

.theme-pill {
  @apply w-5 h-5 rounded-full transition-all cursor-pointer relative;
  background: var(--pill-color);
}

.theme-pill:hover {
  transform: scale(1.15);
}

.theme-pill.active {
  box-shadow: 0 0 0 2px rgb(var(--panel)), 0 0 0 4px var(--pill-color);
}

  .mode-toggle {
    @apply w-9 h-9 flex items-center justify-center transition-all;
    background: rgb(var(--panel));
    color: rgb(var(--muted));
    border: 2px solid rgb(var(--panel-border));
    border-radius: 2px;
    box-shadow: 2px 2px 0 rgb(var(--fg) / 0.5);
  }

  .mode-toggle:hover {
    background: rgb(var(--accent));
    color: #fff;
  }


/* === Main Layout === */
.main-layout {
  @apply relative z-10 max-w-7xl mx-auto px-6 pt-24 pb-16;
  display: grid;
  grid-template-columns: 1fr;
  gap: 3rem;
}

@media (min-width: 1024px) {
  .main-layout {
    grid-template-columns: 200px 1fr;
  }
}

/* === Sidebar === */
.sidebar {
  @apply hidden lg:block;
}

.sidebar-inner {
  @apply sticky top-24;
  max-height: calc(100vh - 8rem);
  overflow-y: auto;
}

.sidebar-header {
  @apply mb-4;
}

.sidebar-label {
  @apply text-xs font-bold uppercase tracking-wider;
  color: rgb(var(--muted));
}

.sidebar-nav {
  @apply space-y-1;
}

.sidebar-link {
  @apply flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all;
  color: rgb(var(--muted));
  border-left: 2px solid transparent;
}

.sidebar-link:hover {
  color: rgb(var(--fg));
  background: rgb(var(--fg) / 0.03);
}

.sidebar-link.active {
  color: rgb(var(--accent));
  background: rgb(var(--accent) / 0.08);
  border-left-color: rgb(var(--accent));
}

.link-num {
  @apply text-xs font-mono;
  color: rgb(var(--muted) / 0.5);
}

.sidebar-link.active .link-num {
  color: rgb(var(--accent) / 0.6);
}

.link-text {
  @apply font-medium;
}

.sidebar-stats {
  @apply grid grid-cols-2 gap-2 mt-6 pt-6 border-t;
  border-color: rgb(var(--panel-border) / 0.5);
}

.mini-stat {
  @apply text-center p-4 rounded-xl;
  background: rgb(var(--panel));
  border: 1px solid rgb(var(--panel-border));
  box-shadow: 0 1px 2px rgb(var(--fg) / 0.05);
}

.mini-stat-value {
  @apply block text-lg font-bold;
  color: rgb(var(--accent));
}

.mini-stat-label {
  @apply text-xs;
  color: rgb(var(--muted));
}

/* === Main Content === */
.main-content {
  @apply min-w-0;
}

/* === Hero Section === */
  .hero-section {
    @apply text-center py-20 mb-16;
    font-family: 'Times New Roman', 'Songti SC', serif;
  }


  .hero-badge {
    @apply inline-flex items-center gap-2 px-4 py-1 text-[11px] font-semibold uppercase tracking-[0.25em] mb-6;
    background: rgb(var(--tag-bg));
    color: rgb(var(--fg));
    border: 2px solid rgb(var(--panel-border));
    box-shadow: 3px 3px 0 rgb(var(--fg) / 0.6);
    border-radius: 2px;
    font-family: 'Courier New', 'SFMono-Regular', monospace;
  }


.badge-dot {
  @apply w-2 h-2 rounded-full;
  background: rgb(var(--accent));
  animation: pulse 2s ease-in-out infinite;
}

.hero-title {
  @apply text-5xl md:text-6xl font-semibold tracking-tight leading-[1.05] mb-6;
}

.title-line {
  @apply block;
}

.title-accent {
  background: linear-gradient(135deg, rgb(var(--accent)), rgb(var(--accent-strong)));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.hero-desc {
  @apply text-base md:text-lg max-w-2xl mx-auto mb-10 leading-relaxed;
  color: rgb(var(--muted));
}

.hero-stats {
  @apply flex flex-wrap justify-center gap-10;
}

.hero-stat {
  @apply text-center min-w-[120px];
}

.stat-num {
  @apply block text-3xl font-semibold tracking-tight;
  color: rgb(var(--fg));
}

.stat-label {
  @apply text-[11px] uppercase tracking-[0.2em];
  color: rgb(var(--muted));
}

/* === Section === */
.ds-section {
  @apply mb-20 scroll-mt-24;
}

.section-head {
  @apply flex items-center gap-8 mb-10;
}

.section-titles {
  @apply flex items-center gap-4;
}

.section-num {
  @apply text-3xl font-semibold tracking-tight;
  color: rgb(var(--accent) / 0.2);
}

  .section-title {
    @apply text-2xl font-semibold tracking-tight;
    font-family: 'Times New Roman', 'Songti SC', serif;
  }


  .section-subtitle {
    @apply text-sm leading-relaxed;
    color: rgb(var(--muted));
    font-family: 'Courier New', 'SFMono-Regular', monospace;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }


.section-line {
  @apply flex-1 h-px;
  background: linear-gradient(to right, rgb(var(--panel-border)), transparent);
}

.section-body {
  @apply space-y-8;
}

/* === Glass Card === */
  .glass-card {
    @apply p-7;
    background: rgb(var(--panel));
    border: 2px solid rgb(var(--panel-border));
    box-shadow: 4px 4px 0 rgb(var(--fg) / 0.7);
    border-radius: 4px;
  }


  .card-subtitle {
    @apply text-xs font-bold uppercase tracking-wider mb-4;
    color: rgb(var(--muted));
    font-family: 'Courier New', 'SFMono-Regular', monospace;
  }


/* === Colors === */
.color-grid {
  @apply grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4;
}

  .color-card {
    @apply overflow-hidden;
    background: rgb(var(--panel));
    border: 2px solid rgb(var(--panel-border));
    box-shadow: 3px 3px 0 rgb(var(--fg) / 0.5);
    border-radius: 2px;
  }


.color-card-hero {
  @apply col-span-2 md:col-span-1;
}

  .color-preview {
    @apply h-20 flex items-end p-3;
    border-bottom: 2px solid rgb(var(--panel-border));
  }


  .color-name {
    @apply text-xs font-semibold text-white;
    text-shadow: 0 1px 0 rgb(0 0 0 / 0.4);
    font-family: 'Courier New', 'SFMono-Regular', monospace;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }


.color-name.dark-text {
  @apply text-gray-600;
  text-shadow: none;
}

.color-meta {
  @apply p-3;
}

.color-var {
  @apply text-xs font-mono;
  color: rgb(var(--muted));
}

.color-desc {
  @apply block text-xs mt-0.5;
  color: rgb(var(--muted-strong));
}

.gradient-showcase {
  @apply grid grid-cols-2 md:grid-cols-4 gap-4 mt-6;
}

.gradient-item {
  @apply h-24 rounded-xl flex items-end p-4;
}

.gradient-item span {
  @apply text-sm font-semibold text-white;
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
}

/* === Typography === */
.typo-showcase {
  @apply space-y-6 mb-8;
}

.typo-item {
  @apply flex flex-col gap-1;
}

.typo-sample {
  color: rgb(var(--fg));
}

.typo-meta {
  @apply text-xs font-mono;
  color: rgb(var(--muted));
}

.typo-numbers {
  @apply grid grid-cols-3 gap-4 pt-6 border-t;
  border-color: rgb(var(--panel-border) / 0.5);
}

.number-display {
  @apply text-center;
}

.number-value {
  @apply block text-3xl font-bold tabular-nums;
  color: rgb(var(--fg));
}

.number-value.accent {
  color: rgb(var(--success));
}

.number-value.danger {
  color: rgb(var(--danger));
}

.number-label {
  @apply text-sm;
  color: rgb(var(--muted));
}

/* === Buttons === */
.button-grid {
  @apply flex flex-wrap gap-3;
}

  .btn {
    @apply inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold transition-all;
    border-radius: 2px;
    font-family: 'Courier New', 'SFMono-Regular', monospace;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .btn:active {
    transform: translate(2px, 2px);
  }

  .btn-primary {
    background: rgb(var(--fg));
    color: rgb(var(--panel));
    border: 2px solid rgb(var(--fg));
    box-shadow: 4px 4px 0 rgb(var(--accent));
  }

  .btn-primary:hover {
    background: rgb(var(--accent));
    color: white;
  }

  .btn-secondary {
    background: rgb(var(--panel));
    border: 2px solid rgb(var(--panel-border));
    color: rgb(var(--fg));
    box-shadow: 3px 3px 0 rgb(var(--fg) / 0.4);
  }

  .btn-secondary:hover {
    background: rgb(var(--tag-bg));
  }

  .btn-ghost {
    color: rgb(var(--muted));
    border: 2px solid transparent;
  }

  .btn-ghost:hover {
    color: rgb(var(--fg));
    border-color: rgb(var(--panel-border));
  }

  .btn-danger {
    background: rgb(var(--danger));
    color: white;
    border: 2px solid rgb(var(--fg));
    box-shadow: 4px 4px 0 rgb(var(--fg));
  }

  .btn-danger:hover {
    background: rgb(var(--danger));
    filter: brightness(0.95);
  }

  .btn-sm {
    @apply px-3 py-1.5 text-xs;
  }

  .btn-icon {
    @apply w-9 h-9;
    background: rgb(var(--panel));
    border: 2px solid rgb(var(--panel-border));
    color: rgb(var(--muted));
    border-radius: 2px;
    box-shadow: 2px 2px 0 rgb(var(--fg) / 0.4);
  }

  .btn-icon:hover {
    background: rgb(var(--tag-bg));
    color: rgb(var(--fg));
  }


.btn:active {
  transform: translateY(1px);
}

.btn-primary {
  background: linear-gradient(135deg, rgb(var(--accent)), rgb(var(--accent-strong)));
  color: white;
  box-shadow: 0 1px 0 rgb(255 255 255 / 0.35), 0 12px 22px rgb(var(--accent) / 0.3);
}

.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 16px 28px rgb(var(--accent) / 0.35);
}

.btn-secondary {
  background: rgb(var(--panel));
  color: rgb(var(--fg));
  border: 1px solid rgb(var(--panel-border));
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.6);
}

.btn-secondary:hover {
  background: rgb(var(--tag-bg));
  border-color: rgb(var(--accent) / 0.3);
}

.btn-ghost {
  background: transparent;
  color: rgb(var(--accent));
  border: 1px solid rgb(var(--panel-border));
}

.btn-ghost:hover {
  background: rgb(var(--tag-bg));
}

.btn-danger {
  background: rgb(var(--danger) / 0.1);
  color: rgb(var(--danger));
  border: 1px solid rgb(var(--danger) / 0.2);
}

.btn-danger:hover {
  background: rgb(var(--danger));
  color: white;
}

.btn-sm {
  @apply h-8 px-4 text-xs;
}

.btn-icon {
  @apply w-10 h-10 p-0;
  background: rgb(var(--panel));
  color: rgb(var(--muted));
  border: 1px solid rgb(var(--panel-border));
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.6);
}

.btn-icon:hover {
  color: rgb(var(--accent));
  border-color: rgb(var(--accent) / 0.3);
  background: rgb(var(--accent) / 0.1);
}

/* === Forms === */
.form-grid {
  @apply grid md:grid-cols-2 gap-4 mb-6;
}

.form-field {
  @apply space-y-2;
}

.field-label {
  @apply text-sm font-medium;
  color: rgb(var(--fg));
}

.input-wrapper {
  @apply relative;
}

.input-icon {
  @apply absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4;
  color: rgb(var(--muted));
}

.input-text {
  @apply w-full h-11 rounded-lg px-4 pl-10 text-sm outline-none transition-all;
  background: rgb(var(--bg));
  border: 1px solid rgb(var(--panel-border));
  color: rgb(var(--fg));
  box-shadow: inset 0 1px 2px rgb(var(--fg) / 0.04);
}

.input-text:focus {
  border-color: rgb(var(--accent));
  box-shadow: 0 0 0 2px rgb(var(--accent) / 0.12);
}

.input-text::placeholder {
  color: rgb(var(--muted));
}

.input-select {
  @apply w-full h-11 rounded-lg px-4 text-sm outline-none transition-all appearance-none cursor-pointer;
  background: rgb(var(--bg)) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") no-repeat right 12px center;
  border: 1px solid rgb(var(--panel-border));
  color: rgb(var(--fg));
  box-shadow: inset 0 1px 2px rgb(var(--fg) / 0.04);
}

.input-select:focus {
  border-color: rgb(var(--accent));
  box-shadow: 0 0 0 2px rgb(var(--accent) / 0.12);
}

.chip-group {
  @apply flex flex-wrap gap-2;
}

.chip {
  @apply h-8 px-4 rounded-full text-sm font-medium transition-all cursor-pointer;
  background: rgb(var(--panel));
  color: rgb(var(--muted-strong));
  border: 1px solid rgb(var(--panel-border));
}

.chip:hover {
  background: rgb(var(--tag-bg));
}

.chip.active {
  background: rgb(var(--accent) / 0.15);
  color: rgb(var(--accent));
  border-color: rgb(var(--accent) / 0.3);
}

/* === Page Cards === */
.page-card {
  @apply rounded-2xl transition-all cursor-pointer;
  background: rgb(var(--panel));
  border: 1px solid rgb(var(--panel-border));
  box-shadow: 0 1px 2px rgb(var(--fg) / 0.04), 0 10px 20px rgb(var(--fg) / 0.04);
}

.page-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 18px 36px rgb(var(--fg) / 0.08);
  border-color: rgb(var(--accent) / 0.3);
}

.page-card-featured {
  @apply relative overflow-hidden;
}

.page-card-featured .card-glow {
  @apply absolute -top-24 -right-24 w-48 h-48 rounded-full;
  background: radial-gradient(circle, rgb(var(--accent) / 0.2), transparent 70%);
}

.page-card .card-content {
  @apply relative p-6;
}

.card-header {
  @apply flex items-center justify-between mb-3;
}

.card-badges {
  @apply flex items-center gap-2;
}

.card-date {
  @apply text-xs;
  color: rgb(var(--muted));
}

.card-title {
  @apply text-xl font-semibold tracking-tight mb-3 transition-colors;
  color: rgb(var(--fg));
}

.page-card:hover .card-title {
  color: rgb(var(--accent));
}

.card-title.deleted {
  @apply line-through opacity-60;
}

.card-excerpt {
  @apply text-sm leading-relaxed mb-4 line-clamp-2;
  color: rgb(var(--muted-strong));
}

.card-author {
  @apply flex items-center gap-3 mb-4;
}

.author-info {
  @apply flex flex-col;
}

.author-name {
  @apply text-sm font-medium;
  color: rgb(var(--fg));
}

.author-name.muted {
  color: rgb(var(--muted));
}

.author-meta {
  @apply text-xs;
  color: rgb(var(--muted));
}

.card-tags {
  @apply flex flex-wrap gap-1.5 mb-4;
}

.tag {
  @apply px-2.5 py-1 rounded-full text-xs font-medium transition-all cursor-pointer;
  background: rgb(var(--tag-bg));
  border: 1px solid rgb(var(--panel-border));
  color: rgb(var(--muted-strong));
}

.tag:hover {
  background: rgb(var(--accent) / 0.1);
  color: rgb(var(--accent));
}

.tag-active {
  background: rgb(var(--accent) / 0.15);
  color: rgb(var(--accent));
  border-color: rgb(var(--accent) / 0.3);
}

.card-stats {
  @apply flex items-center gap-4;
  color: rgb(var(--muted));
}

.stat-item {
  @apply flex items-center gap-1.5 text-sm;
}

.card-stats-mini {
  @apply flex items-center gap-3 mt-3 text-xs;
  color: rgb(var(--muted));
}

.card-stats-mini span {
  @apply flex items-center gap-1;
}

.card-sparkline {
  @apply mt-4 h-6 rounded-lg overflow-hidden;
  background: rgb(var(--fg) / 0.03);
}

.card-sparkline svg {
  @apply w-full h-full;
}

/* Card Grid */
.card-grid-title {
  @apply text-sm font-semibold mt-8 mb-4;
  color: rgb(var(--muted-strong));
}

.card-grid {
  @apply grid gap-4;
}

.card-grid-2 {
  @apply md:grid-cols-2;
}

.card-grid-3 {
  @apply md:grid-cols-3;
}

/* Medium Card */
.page-card-md .card-content {
  @apply p-5;
}

.page-card-md .card-title {
  @apply text-base mb-2;
}

.page-card-md .card-excerpt {
  @apply text-xs mb-3 line-clamp-2;
}

.page-card-md .card-footer {
  @apply flex items-center justify-between mt-3 pt-3 border-t;
  border-color: rgb(var(--panel-border) / 0.3);
}

/* Small Card */
.page-card-sm .card-content {
  @apply p-4;
}

.page-card-sm .card-title {
  @apply text-sm mb-2;
}

.page-card-sm .card-author {
  @apply mb-0;
}

.page-card-sm .author-name {
  @apply text-xs;
}

.page-card-deleted {
  @apply opacity-60;
}

/* === Badges === */
.badge {
  @apply inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold;
}

.badge-vote-up {
  background: rgb(var(--success) / 0.1);
  color: rgb(var(--success));
}

.badge-vote-down {
  background: rgb(var(--danger) / 0.1);
  color: rgb(var(--danger));
}

.badge-neutral {
  background: rgb(var(--muted) / 0.1);
  color: rgb(var(--muted));
}

.badge-premium {
  background: linear-gradient(135deg, rgb(var(--accent)), rgb(var(--accent-strong)));
  color: white;
  box-shadow: 0 2px 6px rgb(var(--accent) / 0.25);
}

.badge-tracking {
  background: rgb(var(--accent) / 0.1);
  color: rgb(var(--accent));
  border: 1px solid rgb(var(--accent) / 0.2);
}

.badge-deleted {
  background: rgb(var(--danger) / 0.1);
  color: rgb(var(--danger));
}

.badge-new {
  background: linear-gradient(135deg, rgb(var(--accent)), rgb(var(--accent-strong)));
  color: white;
}

.badge-group {
  @apply flex flex-wrap gap-2;
}

/* Status Pills */
  .status-pill {
    @apply inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold;
    border: 2px solid rgb(var(--panel-border));
    background: rgb(var(--panel));
    border-radius: 2px;
    font-family: 'Courier New', 'SFMono-Regular', monospace;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }


.status-dot {
  @apply w-2 h-2 rounded-full;
  background: currentColor;
}

.status-success {
  background: rgb(var(--success) / 0.1);
  color: rgb(var(--success));
}

.status-warning {
  background: rgb(var(--warning) / 0.1);
  color: rgb(var(--warning));
}

.status-danger {
  background: rgb(var(--danger) / 0.1);
  color: rgb(var(--danger));
}

.status-processing {
  background: rgb(var(--accent) / 0.1);
  color: rgb(var(--accent));
}

.status-processing .status-dot {
  animation: pulse 1.5s ease-in-out infinite;
}

.tag-cloud {
  @apply flex flex-wrap gap-2;
}

/* === User Cards === */
.user-grid {
  @apply grid md:grid-cols-3 gap-6;
}

.user-card {
  @apply rounded-2xl transition-all;
  background: rgb(var(--panel));
  border: 1px solid rgb(var(--panel-border));
  box-shadow: 0 1px 2px rgb(var(--fg) / 0.04), 0 12px 24px rgb(var(--fg) / 0.05);
}

.user-card:hover {
  border-color: rgb(var(--accent) / 0.3);
  box-shadow: 0 16px 32px rgb(var(--fg) / 0.08);
}

.user-card-featured {
  @apply relative p-6 text-center overflow-hidden;
}

.user-rank {
  @apply absolute top-4 right-4 text-2xl font-bold;
  color: rgb(var(--accent) / 0.3);
}

.user-avatar-wrapper {
  @apply relative inline-block mb-4;
}

.avatar-glow {
  @apply absolute inset-0 rounded-full;
  background: rgb(var(--accent));
  filter: blur(20px);
  opacity: 0.2;
  transform: scale(1.2);
}

.user-avatar-wrapper :deep(> div:first-child) {
  @apply relative z-10;
}

.user-name {
  @apply text-lg font-bold;
  color: rgb(var(--fg));
}

.user-title {
  @apply text-sm mb-4;
  color: rgb(var(--accent));
}

.user-stats {
  @apply grid grid-cols-3 gap-2 mb-4;
}

.user-stat {
  @apply text-center p-2 rounded-xl;
  background: rgb(var(--fg) / 0.03);
}

.user-stat.highlight {
  background: rgb(var(--accent) / 0.1);
}

.user-stat .stat-value {
  @apply block text-lg font-bold;
  color: rgb(var(--fg));
}

.user-stat.highlight .stat-value {
  color: rgb(var(--accent));
}

.user-stat .stat-label {
  @apply text-xs;
  color: rgb(var(--muted));
}

.user-trend {
  @apply relative h-10 rounded-xl overflow-hidden;
  background: rgb(var(--fg) / 0.03);
}

.user-trend svg {
  @apply absolute inset-0 w-full h-full;
}

.trend-label {
  @apply absolute bottom-1 right-2 flex items-center gap-1 text-xs font-medium;
  color: rgb(var(--success));
}

/* Regular User Card */
.user-card-inner {
  @apply flex items-center gap-4 p-4;
}

.user-info {
  @apply flex-1 min-w-0;
}

.user-info .user-name {
  @apply text-base truncate;
}

.user-meta {
  @apply text-xs;
  color: rgb(var(--muted));
}

.user-badge {
  @apply text-sm font-bold;
  color: rgb(var(--accent) / 0.5);
}

/* User Chips */
.user-chips {
  @apply flex flex-wrap gap-2;
}

.user-chip {
  @apply inline-flex items-center gap-2 pl-1 pr-3 py-1 rounded-full text-sm transition-all cursor-pointer;
  background: rgb(var(--fg) / 0.05);
  border: 1px solid rgb(var(--panel-border));
}

.user-chip:hover {
  border-color: rgb(var(--accent) / 0.3);
  background: rgb(var(--accent) / 0.05);
}

.user-chip-add {
  @apply pl-3;
  border-style: dashed;
  color: rgb(var(--muted));
}

/* === KPI Cards === */
.kpi-grid {
  @apply grid grid-cols-2 lg:grid-cols-4 gap-4;
}

.kpi-card {
  @apply rounded-2xl p-5 transition-all;
  background: rgb(var(--panel));
  border: 1px solid rgb(var(--panel-border));
  box-shadow: 0 2px 6px rgb(var(--fg) / 0.05);
}

.kpi-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 32px rgb(0 0 0 / 0.06);
  border-color: rgb(var(--accent) / 0.2);
}

.kpi-header {
  @apply flex items-center justify-between mb-2;
}

.kpi-label {
  @apply text-xs font-medium uppercase tracking-wide;
  color: rgb(var(--muted));
}

.kpi-indicator {
  @apply w-2 h-2 rounded-full;
  background: rgb(var(--muted) / 0.3);
}

.kpi-indicator.active {
  background: rgb(var(--success));
  box-shadow: 0 0 8px rgb(var(--success) / 0.5);
}

.kpi-indicator.pulse {
  animation: pulse 2s ease-in-out infinite;
}

.kpi-value {
  @apply text-3xl font-bold tabular-nums mb-1;
  color: rgb(var(--fg));
}

.kpi-trend {
  @apply flex items-center gap-1 text-xs font-medium;
}

.kpi-trend.up {
  color: rgb(var(--success));
}

.kpi-trend.down {
  color: rgb(var(--danger));
}

.trend-period {
  color: rgb(var(--muted));
  margin-left: 4px;
}

/* Chart */
.chart-card {
  @apply p-6;
}

.chart-header {
  @apply flex items-center justify-between mb-6;
}

.chart-controls {
  @apply flex gap-1 p-1 rounded-lg;
  background: rgb(var(--fg) / 0.05);
}

.chart-btn {
  @apply px-3 py-1 rounded-md text-xs font-medium transition-all;
  color: rgb(var(--muted));
}

.chart-btn:hover {
  color: rgb(var(--fg));
}

.chart-btn.active {
  background: rgb(var(--panel));
  color: rgb(var(--fg));
  box-shadow: 0 2px 4px rgb(0 0 0 / 0.05);
}

.chart-placeholder {
  @apply h-48 flex items-end justify-center;
}

.chart-bars {
  @apply flex items-end gap-4 h-full pb-6;
}

.chart-bar {
  @apply w-10 rounded-t-lg relative transition-all;
  height: var(--h);
  background: rgb(var(--fg) / 0.1);
}

.chart-bar:hover, .chart-bar.active {
  background: linear-gradient(to top, rgb(var(--accent)), rgb(var(--accent-weak)));
}

.chart-bar span {
  @apply absolute -bottom-5 left-1/2 -translate-x-1/2 text-xs;
  color: rgb(var(--muted));
}

/* === Notifications === */
.notification-grid {
  @apply grid md:grid-cols-2 gap-6;
}

.notification-panel, .search-panel {
  @apply rounded-2xl overflow-hidden;
  background: rgb(var(--panel));
  border: 1px solid rgb(var(--panel-border));
  box-shadow: 0 8px 22px rgb(var(--fg) / 0.08);
}

.panel-header {
  @apply flex items-center justify-between px-4 py-3 border-b;
  border-color: rgb(var(--panel-border) / 0.5);
}

.panel-header h4 {
  @apply font-semibold;
}

.link-btn {
  @apply text-xs font-medium;
  color: rgb(var(--accent));
}

.link-btn:hover {
  text-decoration: underline;
}

.notification-list {
  @apply divide-y;
  divide-color: rgb(var(--panel-border) / 0.3);
}

  .notification-item {
    @apply flex items-start gap-4 p-4 transition-all;
    border: 2px solid rgb(var(--panel-border));
    background: rgb(var(--panel));
    border-radius: 4px;
    box-shadow: 3px 3px 0 rgb(var(--fg) / 0.5);
  }


.notification-item:hover {
  background: rgb(var(--fg) / 0.02);
}

.notification-item.unread {
  background: rgb(var(--accent) / 0.03);
}

.notif-icon {
  @apply w-8 h-8 rounded-lg flex items-center justify-center shrink-0;
}

.notif-icon.success {
  background: rgb(var(--success) / 0.1);
  color: rgb(var(--success));
}

.notif-icon.info {
  background: rgb(var(--accent) / 0.1);
  color: rgb(var(--accent));
}

.notif-icon.warning {
  background: rgb(var(--warning) / 0.1);
  color: rgb(var(--warning));
}

.notif-content {
  @apply flex-1 min-w-0;
}

.notif-title {
  @apply text-sm font-medium truncate;
  color: rgb(var(--fg));
}

.notif-meta {
  @apply text-xs mt-0.5;
  color: rgb(var(--muted));
}

.notif-time {
  @apply text-xs shrink-0;
  color: rgb(var(--muted));
}

.panel-footer {
  @apply block text-center py-3 text-sm font-medium border-t transition-colors;
  border-color: rgb(var(--panel-border) / 0.5);
  color: rgb(var(--accent));
}

.panel-footer:hover {
  background: rgb(var(--accent) / 0.05);
}

/* Search Panel */
.search-input-wrapper {
  @apply flex items-center gap-3 px-4 py-3 border-b;
  border-color: rgb(var(--panel-border) / 0.5);
  color: rgb(var(--muted));
}

.search-input-wrapper input {
  @apply flex-1 bg-transparent outline-none text-sm;
  color: rgb(var(--fg));
}

.search-input-wrapper kbd {
  @apply px-2 py-0.5 rounded text-xs;
  background: rgb(var(--fg) / 0.05);
  color: rgb(var(--muted));
}

.search-results {
  @apply max-h-64 overflow-y-auto;
}

.search-group {
  @apply py-2;
}

.group-label {
  @apply block px-4 py-1 text-xs font-medium uppercase tracking-wide;
  color: rgb(var(--muted));
}

.search-result {
  @apply flex items-center justify-between px-4 py-2.5 transition-colors;
}

.search-result:hover, .search-result.active {
  background: rgb(var(--accent) / 0.05);
}

.result-info {
  @apply flex flex-col;
}

.result-title {
  @apply text-sm font-medium;
  color: rgb(var(--fg));
}

.result-meta {
  @apply text-xs;
  color: rgb(var(--muted));
}

.result-type {
  @apply text-xs px-2 py-0.5 rounded;
  background: rgb(var(--accent) / 0.1);
  color: rgb(var(--accent));
}

/* Alerts */
.alert-stack {
  @apply space-y-3 mt-6;
}

  .alert {
    @apply flex items-start gap-4 p-4;
    border: 2px solid rgb(var(--panel-border));
    border-radius: 4px;
    box-shadow: 3px 3px 0 rgb(var(--fg) / 0.5);
  }


  .alert-info {
    background: rgb(var(--accent-weak));
    color: rgb(var(--fg));
  }

  .alert-success {
    background: rgb(var(--success) / 0.12);
    color: rgb(var(--success));
  }

  .alert {
    font-family: 'Courier New', 'SFMono-Regular', monospace;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }


.alert-success {
  background: rgb(var(--success) / 0.08);
  color: rgb(var(--success));
  border: 1px solid rgb(var(--success) / 0.2);
}

.alert-content {
  @apply flex-1;
}

.alert-content strong {
  @apply block text-sm font-semibold;
}

.alert-content p {
  @apply text-sm opacity-90 mt-0.5;
}

.alert-close {
  @apply opacity-60 hover:opacity-100 transition-opacity;
}

/* === Effects === */
.effects-grid {
  @apply grid md:grid-cols-2 lg:grid-cols-4 gap-4;
}

.effect-card {
  @apply rounded-2xl p-4;
  background: rgb(var(--panel));
  border: 1px solid rgb(var(--panel-border));
  box-shadow: 0 1px 4px rgb(var(--fg) / 0.05);
}

.effect-title {
  @apply text-sm font-semibold mb-3;
}

.glass-demo, .glow-demo, .gradient-demo, .noise-demo {
  @apply h-24 rounded-xl relative overflow-hidden flex items-center justify-center;
}

.glass-demo {
  background: linear-gradient(135deg, rgb(var(--accent)), rgb(var(--accent-strong)));
}

.glass-layer {
  @apply absolute inset-2 rounded-lg;
  background: rgb(255 255 255 / 0.2);
  backdrop-filter: blur(10px);
  border: 1px solid rgb(255 255 255 / 0.3);
}

.glass-demo span, .glow-demo span, .gradient-demo span, .noise-demo span {
  @apply relative z-10 text-xs;
  color: white;
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
}

  .glow-demo {
    @apply relative overflow-hidden;
    background: repeating-linear-gradient(90deg, rgb(var(--accent) / 0.08), rgb(var(--accent) / 0.08) 8px, transparent 8px, transparent 16px);
    border-radius: 2px;
  }

  .glow-orb {
    @apply absolute inset-0;
    background: radial-gradient(circle, rgb(var(--accent) / 0.2), transparent 65%);
    filter: blur(18px);
  }


.glow-orb {
  @apply absolute w-20 h-20 rounded-full;
  background: rgb(var(--accent));
  filter: blur(30px);
  opacity: 0.6;
  animation: pulse 3s ease-in-out infinite;
}

.glow-demo span {
  color: rgb(var(--fg));
  text-shadow: none;
}

.gradient-demo {
  background: linear-gradient(135deg, #ff9a56 0%, #ff6b6b 50%, #ee5a9a 100%);
}

.gradient-layer {
  @apply absolute inset-0;
  background: linear-gradient(to top, rgb(0 0 0 / 0.4), transparent);
}

.noise-demo {
  background: rgb(var(--fg) / 0.8);
}

.noise-texture {
  @apply absolute inset-0 opacity-30;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
}

/* Animations */
.animation-grid {
  @apply grid grid-cols-4 gap-4;
}

.anim-item {
  @apply text-center;
}

.anim-box {
  @apply w-12 h-12 mx-auto mb-2 rounded-xl;
  background: linear-gradient(135deg, rgb(var(--accent)), rgb(var(--accent-strong)));
}

.anim-item span {
  @apply text-xs;
  color: rgb(var(--muted));
}

.pulse-anim {
  animation: pulse 2s ease-in-out infinite;
}

.float-anim {
  animation: float 3s ease-in-out infinite;
}

.spin-anim {
  animation: spin 3s linear infinite;
}

.shimmer-anim {
  @apply relative overflow-hidden;
}

.shimmer-anim::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(90deg, transparent, rgb(255 255 255 / 0.3), transparent);
  animation: shimmer 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.7; transform: scale(0.95); }
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

/* Loading States */
.loading-grid {
  @apply grid md:grid-cols-2 gap-6;
}

.skeleton-card {
  @apply flex gap-4 p-4 rounded-xl overflow-hidden;
  background: rgb(var(--fg) / 0.03);
}

.skeleton {
  @apply rounded overflow-hidden relative;
  background: rgb(var(--fg) / 0.08);
}

.skeleton::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(90deg, transparent, rgb(var(--fg) / 0.06), transparent);
  animation: skeleton-shimmer 1.5s ease-in-out infinite;
}

@keyframes skeleton-shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

.skeleton-avatar {
  @apply w-12 h-12 rounded-full shrink-0;
}

.skeleton-content {
  @apply flex-1 space-y-2 overflow-hidden;
}

.skeleton-title {
  @apply h-4 w-3/4;
}

.skeleton-text {
  @apply h-3 w-full;
}

.skeleton-text.short {
  @apply w-1/2;
}

.loading-spinner {
  @apply flex flex-col items-center justify-center gap-3 p-8;
}

.spinner {
  @apply w-8 h-8 rounded-full border-2;
  border-color: rgb(var(--panel-border));
  border-top-color: rgb(var(--accent));
  animation: spin 0.8s linear infinite;
}

.loading-spinner span {
  @apply text-sm;
  color: rgb(var(--muted));
}

/* === Code Block === */
.code-card {
  @apply overflow-hidden;
}

.code-header {
  @apply flex items-center justify-between px-4 py-2 border-b;
  border-color: rgb(var(--panel-border) / 0.5);
  background: rgb(var(--fg) / 0.02);
}

.code-lang {
  @apply text-xs font-medium;
  color: rgb(var(--muted));
}

.copy-btn {
  @apply flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded transition-colors;
  color: rgb(var(--muted));
}

.copy-btn:hover {
  background: rgb(var(--fg) / 0.05);
  color: rgb(var(--fg));
}

.code-block {
  @apply p-4 text-xs leading-relaxed overflow-x-auto;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: rgb(var(--muted-strong));
}

/* === Footer === */
.ds-footer {
  @apply mt-20 py-8 text-center border-t;
  border-color: rgb(var(--panel-border) / 0.5);
}

.footer-content {
  @apply flex flex-col items-center gap-2;
}

.footer-content p {
  @apply text-sm;
  color: rgb(var(--muted));
}

.footer-sub {
  @apply text-xs;
  color: rgb(var(--muted) / 0.6);
}

/* === Utilities === */
.mt-4 { margin-top: 1rem; }
.mt-6 { margin-top: 1.5rem; }

.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
