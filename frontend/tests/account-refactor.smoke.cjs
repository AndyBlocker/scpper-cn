const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const baseUrl = process.env.ACCOUNT_TEST_BASE_URL || 'http://127.0.0.1:19876'
const outputDir = process.env.ACCOUNT_TEST_OUTPUT_DIR || '/tmp/scpper-account-refactor-evidence'
const notificationsEnabled = process.env.ACCOUNT_TEST_NOTIFICATIONS_ENABLED === '1'
const qqFrontendEnabled = process.env.ACCOUNT_TEST_QQ_ENABLED === '1'
const iso = '2026-07-30T08:00:00.000Z'
const transparentPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64'
)

const collection = {
  id: 501,
  ownerId: 1,
  title: 'SCP 精选',
  slug: 'scp-picks',
  visibility: 'PRIVATE',
  description: 'Playwright 收藏夹',
  notes: '用于交互验收',
  coverImageUrl: null,
  coverImageOffsetX: 0,
  coverImageOffsetY: 0,
  coverImageScale: 1,
  isDefault: true,
  publishedAt: null,
  createdAt: iso,
  updatedAt: iso,
  itemCount: 1
}

const collectionItem = {
  id: 601,
  collectionId: 501,
  pageId: 701,
  annotation: '示例批注',
  order: 0,
  pinned: true,
  createdAt: iso,
  updatedAt: iso,
  page: {
    id: 701,
    wikidotId: 10001,
    currentUrl: 'https://scp-wiki-cn.wikidot.com/scp-cn-001',
    slug: 'scp-cn-001',
    title: 'SCP-CN-001',
    alternateTitle: '测试页面',
    rating: 128
  }
}

const secondCollectionItem = {
  ...collectionItem,
  id: 602,
  pageId: 702,
  annotation: '第二条示例批注',
  order: 1,
  pinned: false,
  page: {
    ...collectionItem.page,
    id: 702,
    wikidotId: 10002,
    currentUrl: 'https://scp-wiki-cn.wikidot.com/scp-cn-002',
    slug: 'scp-cn-002',
    title: 'SCP-CN-002',
    alternateTitle: '第二个测试页面',
    rating: 96
  }
}

function authUser(options = {}) {
  const featureEnabled = options.qqFeatureEnabled === true
  const qqBound = options.qqBound === true
  const pendingChallenge = options.qqPending === true
  return {
    ok: true,
    user: {
      id: options.userId || 'pw-user-1',
      email: options.email || 'playwright@example.com',
      displayName: options.displayName || '验收用户',
      linkedWikidotId: options.linked === false ? null : 123456,
      lastLoginAt: iso,
      qqBinding: {
        bound: qqBound,
        addressMask: qqBound ? '1234***8' : null,
        status: qqBound ? (options.qqStatus || 'ACTIVE') : null,
        pendingChallenge,
        capabilities: {
          featureEnabled,
          createBinding: featureEnabled && !qqBound,
          deliverNotifications: featureEnabled && qqBound && (options.qqStatus || 'ACTIVE') === 'ACTIVE',
          manageExistingBinding: qqBound || pendingChallenge
        }
      }
    }
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function json(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body)
  })
}

function createApiHandler(options, requests) {
  let authMeCount = 0
  let preferencesReadCount = 0
  let collectionDetailReadCount = 0
  let currentAuth = { ...options }
  let currentCollectionItems = options.collectionMutationFlow
    ? [{ ...collectionItem }, { ...secondCollectionItem }]
    : [{ ...collectionItem }]

  return async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const apiPath = url.pathname.slice('/api'.length)
    const method = request.method()
    if (options.forceServerAccount === 'B') {
      currentAuth = {
        ...currentAuth,
        userId: 'pw-user-2',
        email: 'second@example.com',
        displayName: '第二位用户',
        linked: true
      }
    }
    const requestOwner = currentAuth.userId || 'pw-user-1'
    const expectedUserId = request.headers()['x-scpper-expected-user-id'] || null
    const requestEntry = {
      method,
      path: apiPath,
      userId: requestOwner,
      expectedUserId,
      rejected: false,
      body: request.postDataJSON?.() || null
    }
    requests.push(requestEntry)

    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(method)
      && expectedUserId
      && expectedUserId !== requestOwner
    ) {
      requestEntry.rejected = true
      return json(route, {
        ok: false,
        code: 'account_mismatch',
        error: '登录账号已切换，请刷新后重试。'
      }, 409)
    }

    if (apiPath.startsWith('/avatar/')) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: transparentPng })
    }

    if (apiPath === '/auth/me' && method === 'GET') {
      authMeCount += 1
      const responseSnapshot = { ...currentAuth }
      if (options.authError) {
        return json(route, { ok: false, error: '认证服务暂时不可用' }, 503)
      }
      if (options.malformedAuth) {
        return json(route, { ok: true, user: {} })
      }
      if (options.delayInitialAuth && authMeCount === 1) {
        await delay(options.delayInitialAuth)
      } else if (options.delayAuthAfterSwitch && responseSnapshot.userId === 'pw-user-2') {
        await delay(options.delayAuthAfterSwitch)
      }
      return json(route, authUser(responseSnapshot))
    }

    if (apiPath === '/auth/login' && method === 'POST') {
      if (options.switchAccount) {
        currentAuth = {
          ...currentAuth,
          userId: 'pw-user-2',
          email: 'second@example.com',
          displayName: '第二位用户',
          linked: true
        }
      }
      if (options.malformedLogin) {
        return json(route, { ok: true, user: {} })
      }
      return json(route, authUser(currentAuth))
    }

    if (apiPath === '/auth/logout' && method === 'POST') {
      if (options.logoutAmbiguous) {
        return json(route, { ok: false, error: '代理连接失败' }, 503)
      }
      return json(route, { ok: true })
    }

    if (apiPath === '/auth/password' && method === 'PATCH') {
      return json(route, { ok: true })
    }

    if (apiPath === '/auth/profile' && method === 'PATCH') {
      const submittedName = request.postDataJSON()?.displayName || currentAuth.displayName
      currentAuth = {
        ...currentAuth,
        displayName: submittedName
      }
      if (options.profileNetworkSwitch) {
        currentAuth = {
          ...currentAuth,
          userId: 'pw-user-2',
          email: 'second@example.com',
          displayName: submittedName,
          linked: true
        }
        return json(route, { ok: false, error: '响应在途中丢失' }, 503)
      }
      if (options.profileResponseLost) {
        return route.abort('connectionreset')
      }
      if (options.malformedProfile) {
        return json(route, { ok: true, user: {} })
      }
      return json(route, authUser(currentAuth))
    }

    if (apiPath === '/wikidot-binding/status' && method === 'GET') {
      return json(route, { ok: true, task: null })
    }

    if (apiPath === '/wikidot-binding/resolve' && method === 'GET') {
      return json(route, {
        ok: true,
        users: [{ wikidotId: 123456, displayName: '测试作者', username: 'test-author' }]
      })
    }

    if (apiPath === '/qq-binding/status' && method === 'GET') {
      if (options.qqStatusError) {
        return json(route, { ok: false, error: 'QQ 状态暂时不可用' }, 503)
      }
      return json(route, {
        ok: true,
        botQq: '10000001',
        binding: currentAuth.qqBound
          ? {
              addressMask: '1234***8',
              displayName: '测试 QQ',
              status: currentAuth.qqStatus || 'ACTIVE',
              verifiedAt: iso,
              suspendedUntil: null
            }
          : null,
        challenge: currentAuth.qqPending
          ? { codeHint: '1234', expiresAt: '2026-07-31T08:00:00.000Z', createdAt: iso }
          : null
      })
    }

    if (apiPath === '/qq-binding/start' && method === 'POST') {
      currentAuth = { ...currentAuth, qqPending: true }
      return json(route, {
        ok: true,
        code: 'SCPPER-ABCDEFGHJKMN',
        expiresAt: '2026-07-31T08:00:00.000Z',
        botQq: '10000001',
        instructions: ['添加机器人好友', '填写验证码']
      })
    }

    if (apiPath === '/qq-binding/cancel' && method === 'DELETE') {
      currentAuth = { ...currentAuth, qqPending: false }
      return json(route, { ok: true })
    }

    if (apiPath === '/qq-binding/unbind' && method === 'POST') {
      currentAuth = { ...currentAuth, qqBound: false, qqPending: false }
      return json(route, { ok: true })
    }

    if (apiPath === '/alerts/preferences' && method === 'GET') {
      preferencesReadCount += 1
      const responseOwner = currentAuth.userId || 'pw-user-1'
      if (options.delayFirstPreferences && preferencesReadCount === 1) {
        await delay(options.delayFirstPreferences)
      }
      return json(route, {
        ok: true,
        preferences: {
          voteCountThreshold: responseOwner === 'pw-user-2' ? 91 : 37,
          revisionFilter: responseOwner === 'pw-user-2' ? 'NON_OWNER' : 'ANY',
          ignoreLinkedWikidotSelfRevision: true,
          mutedMetrics: {
            COMMENT_COUNT: false,
            VOTE_COUNT: false,
            REVISION_COUNT: false
          }
        }
      })
    }

    if (apiPath === '/collections' && method === 'GET') {
      const ownerCollection = currentAuth.userId === 'pw-user-2'
        ? { ...collection, id: 502, title: '第二位用户的收藏夹', slug: 'second-picks' }
        : collection
      const items = options.collectionDetailError
        ? [
            ownerCollection,
            { ...collection, id: 502, title: '待加载收藏夹', slug: 'detail-error' }
          ]
        : [ownerCollection]
      return json(route, { ok: true, items, total: items.length })
    }

    if (apiPath === '/collections/501' && method === 'GET') {
      collectionDetailReadCount += 1
      if (options.collectionMutationFlow && collectionDetailReadCount > 1) {
        await delay(450)
      }
      return json(route, {
        ok: true,
        collection: {
          ...collection,
          itemCount: currentCollectionItems.length
        },
        items: currentCollectionItems
      })
    }

    if (apiPath === '/collections/502' && method === 'GET') {
      if (options.collectionDetailError) {
        return json(route, { ok: false, error: '详情服务暂时不可用' }, 503)
      }
      const secondCollection = {
        ...collection,
        id: 502,
        title: '第二位用户的收藏夹',
        slug: 'second-picks'
      }
      return json(route, {
        ok: true,
        collection: secondCollection,
        items: [{ ...collectionItem, id: 602, collectionId: 502 }]
      })
    }

    if (apiPath === '/collections/501/items/reorder' && method === 'POST') {
      const order = request.postDataJSON()?.order
      if (Array.isArray(order)) {
        currentCollectionItems = order
          .map(id => currentCollectionItems.find(item => item.id === id))
          .filter(Boolean)
          .map((item, index) => ({ ...item, order: index }))
      }
      return json(route, { ok: true, items: currentCollectionItems })
    }

    if (/^\/collections\/501\/items\/\d+$/.test(apiPath) && method === 'PATCH') {
      if (options.collectionItemUpdateError) {
        return json(route, { ok: false, error: '批注服务暂时不可用' }, 503)
      }
      const itemId = Number(apiPath.split('/').at(-1))
      const patch = request.postDataJSON() || {}
      currentCollectionItems = currentCollectionItems.map(item => (
        item.id === itemId ? { ...item, ...patch } : item
      ))
      const item = currentCollectionItems.find(candidate => candidate.id === itemId)
      return json(route, { ok: true, item })
    }

    if (apiPath.startsWith('/collections/') && method === 'PATCH') {
      if (options.collectionUpdateError) {
        return json(route, { ok: false, error: 'require_linked_wikidot' }, 400)
      }
      if (options.delayCollectionWrite) {
        await delay(options.delayCollectionWrite)
      }
      return json(route, {
        ok: true,
        collection,
        item: currentCollectionItems[0],
        items: currentCollectionItems
      })
    }

    if (apiPath.startsWith('/collections/') && ['POST', 'DELETE'].includes(method)) {
      return json(route, {
        ok: true,
        collection,
        item: currentCollectionItems[0],
        items: currentCollectionItems
      })
    }

    if (apiPath === '/follows' && method === 'GET') {
      return json(route, { ok: true, follows: [] })
    }

    return json(route, { ok: true })
  }
}

async function scenario(browser, name, options, run, viewport = { width: 1280, height: 900 }) {
  if (process.env.SCENARIO && process.env.SCENARIO !== name) return

  const context = await browser.newContext({
    viewport,
    colorScheme: 'dark',
    locale: 'zh-CN',
    reducedMotion: 'reduce'
  })
  await context.addInitScript(() => {
    localStorage.setItem('theme', 'dark')
    localStorage.setItem('color-scheme', 'aurora')
  })

  const requests = []
  await context.route(
    url => url.hostname.includes('google-analytics.com') || url.hostname === 'www.google.com',
    route => route.abort()
  )
  await context.route(
    url => url.pathname.startsWith('/api/'),
    createApiHandler(options, requests)
  )

  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))

  process.stdout.write(`• ${name}\n`)
  await run(page, requests, context)
  assert.deepEqual(pageErrors, [], `${name}: browser page errors`)
  await page.screenshot({
    path: path.join(outputDir, `${name}.png`),
    fullPage: true
  })
  await context.close()
}

async function dimensions(page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth
  }))
}

async function login(page) {
  await page.getByLabel('邮箱', { exact: true }).fill('second@example.com')
  await page.getByLabel('密码', { exact: true }).fill('password-for-smoke-test')
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  const browser = await chromium.launch({ headless: true })

  try {
    await scenario(
      browser,
      'overview-mobile',
      { linked: false },
      async (page, requests) => {
        await page.goto(`${baseUrl}/account`, { waitUntil: 'domcontentloaded' })
        await page.getByText('playwright@example.com', { exact: true }).waitFor()
        await page.getByRole('heading', { name: '账号概览' }).waitFor()
        assert.equal(await page.locator('a[href="/notifications"]').count(), 0)
        assert.equal(await page.locator('a[href="/settings/notifications"]').count(), 0)
        assert.equal(await page.getByText('通知设置', { exact: true }).count(), 0)
        const sectionNavigation = page.locator('#account-section-navigation')
        assert.equal(await sectionNavigation.inputValue(), '/account')
        assert.ok((await sectionNavigation.boundingBox()).height >= 44)
        const size = await dimensions(page)
        assert.ok(size.scrollWidth <= size.innerWidth, JSON.stringify(size))
        assert.ok(size.bodyScrollWidth <= size.innerWidth, JSON.stringify(size))
        assert.ok(requests.some(entry => entry.path === '/auth/me' && entry.method === 'GET'))
      },
      { width: 320, height: 640 }
    )

    await scenario(
      browser,
      'account-route-announcer',
      { linked: true },
      async (page) => {
        await page.goto(`${baseUrl}/account`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('heading', { name: '账号概览' }).waitFor()
        await page
          .getByRole('navigation', { name: '账号中心导航' })
          .getByRole('link', { name: /个人资料/ })
          .click()
        await page.getByRole('heading', { name: '个人资料' }).waitFor()

        const announcer = page.locator('.nuxt-route-announcer [role="alert"]')
        await announcer.waitFor({ state: 'attached' })
        assert.match(await announcer.innerText(), /个人资料/)
        assert.equal(await announcer.getAttribute('aria-live'), 'polite')
      }
    )

    await scenario(
      browser,
      'connections-qq-hidden',
      { linked: false },
      async (page, requests) => {
        await page.goto(`${baseUrl}/account/connections`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('heading', { name: 'Wikidot 身份', exact: true }).waitFor()
        assert.equal(
          await page.getByRole('heading', {
            name: '连接 Wikidot 身份',
            exact: true,
            level: 3
          }).count(),
          1
        )
        assert.equal(await page.getByRole('heading', { name: 'QQ 连接' }).count(), 0)
        assert.equal(requests.filter(entry => entry.path === '/qq-binding/status').length, 0)
      }
    )

    await scenario(
      browser,
      'connections-bound-hidden-while-disabled',
      { linked: true, qqBound: true, qqStatusError: true },
      async (page, requests) => {
        await page.goto(`${baseUrl}/account/connections`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('heading', { name: 'Wikidot 身份', exact: true }).waitFor()
        assert.equal(await page.getByRole('heading', { name: 'QQ 连接' }).count(), 0)
        assert.equal(await page.getByRole('button', { name: '解绑 QQ' }).count(), 0)
        assert.equal(requests.filter(entry => entry.path === '/qq-binding/status').length, 0)

        await page.goto(`${baseUrl}/account`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('heading', { name: '账号概览' }).waitFor()
        assert.equal(await page.getByText('QQ 已连接', { exact: true }).count(), 0)
        assert.equal(await page.getByText('QQ 功能暂停，可管理旧连接', { exact: true }).count(), 0)
      }
    )

    await scenario(
      browser,
      'connections-pending-hidden-while-disabled',
      { linked: true, qqPending: true, qqFeatureEnabled: false },
      async (page, requests) => {
        await page.goto(`${baseUrl}/account/connections`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('heading', { name: 'Wikidot 身份', exact: true }).waitFor()
        assert.equal(await page.getByRole('heading', { name: 'QQ 连接' }).count(), 0)
        assert.equal(await page.getByRole('button', { name: '取消未完成的绑定' }).count(), 0)
        assert.equal(requests.filter(entry => entry.path === '/qq-binding/status').length, 0)
      }
    )

    if (!qqFrontendEnabled) {
      await scenario(
        browser,
        'connections-frontend-switch-wins',
        { linked: true, qqFeatureEnabled: true },
        async (page, requests) => {
          await page.goto(`${baseUrl}/account/connections`, { waitUntil: 'domcontentloaded' })
          await page.getByRole('heading', { name: 'Wikidot 身份', exact: true }).waitFor()
          assert.equal(await page.getByRole('heading', { name: 'QQ 连接' }).count(), 0)
          assert.equal(await page.getByRole('button', { name: '开始绑定' }).count(), 0)
          assert.equal(requests.filter(entry => entry.path === '/qq-binding/start').length, 0)
        }
      )

    } else {
      await scenario(
        browser,
        'connections-feature-restorable',
        { linked: true, qqFeatureEnabled: true },
        async (page, requests) => {
          await page.goto(`${baseUrl}/account/connections`, { waitUntil: 'domcontentloaded' })
          await page.getByRole('button', { name: '开始绑定' }).click()
          await page.getByText('一次性验证码', { exact: true }).waitFor()
          await page.getByText('ABCD', { exact: true }).waitFor()
          assert.equal(requests.filter(entry => entry.path === '/qq-binding/start').length, 1)
        }
      )

      await scenario(
        browser,
        'connections-enabled-cancel-keeps-success',
        { linked: true, qqPending: true, qqFeatureEnabled: false },
        async (page, requests) => {
          await page.goto(`${baseUrl}/account/connections`, { waitUntil: 'domcontentloaded' })
          await page.getByRole('button', { name: '取消未完成的绑定' }).click()
          await page.getByText('未完成的 QQ 绑定已取消。', { exact: false }).waitFor()
          assert.equal(await page.getByRole('heading', { name: 'QQ 连接' }).count(), 1)
          assert.equal(requests.filter(entry => (
            entry.path === '/qq-binding/cancel' && entry.method === 'DELETE'
          )).length, 1)
        }
      )

      await scenario(
        browser,
        'connections-enabled-unbind-keeps-success',
        { linked: true, qqBound: true, qqFeatureEnabled: false },
        async (page, requests) => {
          await page.goto(`${baseUrl}/account/connections`, { waitUntil: 'domcontentloaded' })
          await page.getByRole('button', { name: '解绑 QQ' }).click()
          await page.getByLabel('登录密码', { exact: true }).fill('password-for-smoke-test')
          await page.getByRole('button', { name: '确认解绑' }).click()
          await page.getByText('QQ 连接已解绑。', { exact: false }).waitFor()
          assert.equal(await page.getByRole('heading', { name: 'QQ 连接' }).count(), 1)
          assert.equal(requests.filter(entry => (
            entry.path === '/qq-binding/unbind' && entry.method === 'POST'
          )).length, 1)
        }
      )
    }

    await scenario(
      browser,
      'auth-service-error',
      { authError: true },
      async (page) => {
        await page.goto(`${baseUrl}/account/profile`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('heading', { name: '暂时无法读取账号信息' }).waitFor()
        assert.equal(await page.getByLabel('昵称', { exact: true }).count(), 0)
        assert.equal(await page.getByRole('link', { name: '登录', exact: true }).count(), 0)
        await page.getByText('账号状态待确认', { exact: true }).waitFor()
      }
    )

    await scenario(
      browser,
      'malformed-auth-payload-is-rejected',
      { malformedAuth: true },
      async (page) => {
        await page.goto(`${baseUrl}/account/profile`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('heading', { name: '暂时无法读取账号信息' }).waitFor()
        assert.equal(await page.getByLabel('昵称', { exact: true }).count(), 0)
        assert.equal(await page.getByText('未设置昵称', { exact: true }).count(), 0)
      }
    )

    await scenario(
      browser,
      'security-and-logout-ambiguity',
      { linked: true, logoutAmbiguous: true },
      async (page, requests) => {
        await page.goto(`${baseUrl}/account/security`, { waitUntil: 'domcontentloaded' })
        await page.getByLabel('当前密码', { exact: true }).waitFor()
        await page.getByRole('button', { name: '退出当前登录' }).click()
        await page.getByText('退出未完成，你仍处于登录状态，请重试。', { exact: true }).waitFor()
        assert.equal(new URL(page.url()).pathname, '/account/security')
        assert.equal(requests.filter(entry => entry.path === '/auth/logout').length, 1)
        assert.ok(requests.filter(entry => entry.path === '/auth/me').length >= 2)
      }
    )

    const stalePasswordOptions = { linked: true, delayAuthAfterSwitch: 800 }
    await scenario(
      browser,
      'stale-password-write-is-rejected-without-login-redirect',
      stalePasswordOptions,
      async (page, requests) => {
        await page.goto(`${baseUrl}/account/security`, { waitUntil: 'domcontentloaded' })
        await page.getByText('playwright@example.com', { exact: true }).waitFor()
        await page.getByLabel('当前密码', { exact: true }).fill('old-password')
        await page.getByLabel('新密码', { exact: true }).fill('new-password')
        await page.getByLabel('再次输入新密码', { exact: true }).fill('new-password')

        stalePasswordOptions.forceServerAccount = 'B'
        await page.getByRole('button', { name: '修改密码', exact: true }).click()
        await page.getByText('second@example.com', { exact: true }).waitFor()
        await page.getByLabel('当前密码', { exact: true }).waitFor()
        assert.equal(new URL(page.url()).pathname, '/account/security')
        assert.equal(await page.getByRole('heading', { name: '账号登录' }).count(), 0)

        const writes = requests.filter(entry => (
          entry.path === '/auth/password' && entry.method === 'PATCH'
        ))
        assert.equal(writes.length, 1)
        assert.equal(writes[0].expectedUserId, 'pw-user-1')
        assert.equal(writes[0].userId, 'pw-user-2')
        assert.equal(writes[0].rejected, true)
      }
    )

    await scenario(
      browser,
      'profile-save-state',
      { linked: true },
      async (page) => {
        await page.goto(`${baseUrl}/account/profile`, { waitUntil: 'domcontentloaded' })
        const input = page.getByLabel('昵称', { exact: true })
        const button = page.getByRole('button', { name: '保存昵称' })
        await input.waitFor()
        assert.equal(await button.isDisabled(), true)
        await input.fill('新的验收昵称')
        await button.click()
        await page.getByText('昵称已保存。', { exact: true }).waitFor()
        assert.equal(await button.isDisabled(), true)
        await input.fill('再次编辑但尚未保存')
        assert.equal(await page.getByText('昵称已保存。', { exact: true }).count(), 0)
        assert.equal(await button.isEnabled(), true)
      }
    )

    await scenario(
      browser,
      'malformed-profile-response-is-revalidated',
      { linked: true, malformedProfile: true },
      async (page, requests) => {
        await page.goto(`${baseUrl}/account/profile`, { waitUntil: 'domcontentloaded' })
        const input = page.getByLabel('昵称', { exact: true })
        await input.fill('重查后确认的昵称')
        const authReadsBefore = requests.filter(entry => entry.path === '/auth/me').length
        await page.getByRole('button', { name: '保存昵称' }).click()
        await page.getByText('昵称已保存。', { exact: true }).waitFor()
        assert.ok(
          requests.filter(entry => entry.path === '/auth/me').length > authReadsBefore,
          '畸形 profile DTO 后必须重新读取可信会话'
        )
        assert.equal(await input.inputValue(), '重查后确认的昵称')
      }
    )

    await scenario(
      browser,
      'lost-profile-response-broadcasts-confirmed-profile',
      { linked: true, profileResponseLost: true },
      async (page, requests) => {
        await page.goto(`${baseUrl}/account/profile`, { waitUntil: 'domcontentloaded' })
        const input = page.getByLabel('昵称', { exact: true })
        const authReadsBefore = requests.filter(entry => entry.path === '/auth/me').length
        const broadcastBefore = await page.evaluate(() => (
          localStorage.getItem('scpper:auth-session-version')
        ))

        await input.fill('响应丢失后确认的新昵称')
        await page.getByRole('button', { name: '保存昵称' }).click()
        await page.getByText('昵称已保存。', { exact: true }).waitFor()

        assert.ok(
          requests.filter(entry => entry.path === '/auth/me').length > authReadsBefore,
          'PATCH 响应丢失后必须通过 /auth/me 确认最终昵称'
        )
        const broadcastAfter = await page.evaluate(() => (
          localStorage.getItem('scpper:auth-session-version')
        ))
        assert.notEqual(broadcastAfter, broadcastBefore)
        assert.equal(JSON.parse(broadcastAfter).reason, 'profile')
      }
    )

    await scenario(
      browser,
      'lost-profile-response-cannot-confirm-another-account',
      { linked: true, profileNetworkSwitch: true },
      async (page) => {
        await page.goto(`${baseUrl}/account/profile`, { waitUntil: 'domcontentloaded' })
        const input = page.getByLabel('昵称', { exact: true })
        await input.fill('两个账号碰巧相同的昵称')
        await page.getByRole('button', { name: '保存昵称' }).click()
        await page.getByText('second@example.com', { exact: true }).waitFor()
        assert.equal(await page.getByText('昵称已保存。', { exact: true }).count(), 0)
      }
    )

    await scenario(
      browser,
      'appearance-works-without-auth',
      { authError: true },
      async (page) => {
        await page.goto(`${baseUrl}/settings/appearance`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('heading', { name: '快速配色' }).waitFor()
        const advanced = page.getByRole('button', { name: '高级外观设置', exact: false })
        await advanced.click()
        await page.getByRole('heading', { name: '自定义颜色' }).waitFor()
        const colorInputs = page.locator('input[type="color"]')
        assert.ok(await colorInputs.count() >= 20)
        for (let index = 0; index < await colorInputs.count(); index += 1) {
          assert.ok(await colorInputs.nth(index).evaluate(input => input.labels?.length > 0))
        }
      }
    )

    if (!notificationsEnabled) {
      await scenario(
        browser,
        'legacy-and-paused-routes',
        { linked: true },
        async (page) => {
          await page.goto(`${baseUrl}/account?tab=appearance`, { waitUntil: 'domcontentloaded' })
          await page.getByRole('heading', { name: '外观设置' }).waitFor()
          assert.equal(new URL(page.url()).pathname, '/settings/appearance')
          await page.goto(`${baseUrl}/notifications`, { waitUntil: 'domcontentloaded' })
          await page.getByText('站内通知功能暂时关闭', { exact: true }).waitFor()
          const redirected = new URL(page.url())
          assert.equal(redirected.pathname, '/account')
          assert.equal(redirected.searchParams.get('notice'), 'notifications-paused')
        }
      )
    }

    if (notificationsEnabled) {
      await scenario(
        browser,
        'notification-settings-account-switch-isolated',
        { linked: true, switchAccount: true, delayFirstPreferences: 900 },
        async (page, requests, context) => {
          await page.goto(`${baseUrl}/settings/notifications`, { waitUntil: 'domcontentloaded' })
          await page.getByText('正在从服务端加载提醒偏好…', { exact: true }).waitFor()

          const secondPage = await context.newPage()
          await secondPage.goto(`${baseUrl}/auth/login`, { waitUntil: 'domcontentloaded' })
          await login(secondPage)
          await secondPage.getByText('second@example.com', { exact: true }).waitFor()

          const threshold = page.getByLabel('票数变化阈值')
          await threshold.waitFor()
          assert.equal(await threshold.inputValue(), '91')
          assert.equal(await threshold.isEnabled(), true)
          assert.ok(
            requests.filter(entry => entry.path === '/alerts/preferences').length >= 2,
            '账号切换后必须为新身份重新读取提醒偏好'
          )
          await page.waitForTimeout(1100)
          assert.equal(await threshold.inputValue(), '91')
          await secondPage.close()
        }
      )

      await scenario(
        browser,
        'notification-qq-capability-is-server-authoritative',
        { linked: true, qqBound: true, qqFeatureEnabled: false },
        async (page) => {
          await page.goto(`${baseUrl}/settings/notifications`, { waitUntil: 'domcontentloaded' })
          await page.getByText('功能暂停（当前不会通过 QQ 投递）', { exact: true }).waitFor()
          assert.equal(
            await page.getByText('通常在事件发生后一小时内送达。', { exact: false }).count(),
            0
          )
        }
      )
    }

    await scenario(
      browser,
      'collections-unlinked-mobile-dialog',
      { linked: false },
      async (page) => {
        await page.goto(`${baseUrl}/collections`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('heading', { name: 'SCP 精选', exact: true }).first().waitFor()
        const sectionNavigation = page.locator('#account-section-navigation')
        assert.equal(await sectionNavigation.inputValue(), '/collections')
        assert.equal(
          await sectionNavigation.getAttribute('aria-describedby'),
          'account-section-navigation-hint'
        )
        assert.equal(
          await page.locator('#account-section-navigation-hint').innerText(),
          '选择后会立即前往对应页面。'
        )
        const selectedCollection = page.getByRole('button', { name: /SCP 精选/ }).first()
        assert.equal(await selectedCollection.getAttribute('aria-pressed'), 'true')
        assert.equal(
          await selectedCollection.getAttribute('aria-controls'),
          'active-collection-detail'
        )
        assert.equal(
          await page.locator('#active-collection-detail').getAttribute('role'),
          'region'
        )
        const editButton = page.getByRole('button', { name: '编辑', exact: true }).first()
        await editButton.click()
        const dialog = page.getByRole('dialog')
        await dialog.waitFor()
        assert.equal(await dialog.getAttribute('aria-modal'), 'true')
        const visibilitySwitch = dialog.getByRole('switch', { name: '公开展示收藏夹' })
        assert.equal(await visibilitySwitch.isDisabled(), true)
        assert.equal(await dialog.getByRole('link', { name: '前往绑定' }).count(), 1)
        const box = await dialog.boundingBox()
        assert.ok(box.y >= 0 && box.y + box.height <= 667)
        const size = await dimensions(page)
        assert.ok(size.scrollWidth <= size.innerWidth, JSON.stringify(size))
        await dialog.getByLabel('名称', { exact: true }).fill('未保存的标题')
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'detached' })
        assert.equal(await editButton.evaluate(node => document.activeElement === node), true)
        await editButton.click()
        await page.getByRole('dialog').waitFor()
        assert.equal(
          await page.getByRole('dialog').getByLabel('名称', { exact: true }).inputValue(),
          'SCP 精选'
        )
        await page.keyboard.press('Escape')
        await sectionNavigation.selectOption('/account')
        await page.getByRole('heading', { name: '账号概览' }).waitFor()
        assert.equal(new URL(page.url()).pathname, '/account')
      },
      { width: 375, height: 667 }
    )

    await scenario(
      browser,
      'collection-submit-error-stays-in-dialog',
      { linked: true, collectionUpdateError: true },
      async (page) => {
        await page.goto(`${baseUrl}/collections`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('heading', { name: 'SCP 精选', exact: true }).first().waitFor()
        await page.getByRole('button', { name: '编辑', exact: true }).first().click()
        const dialog = page.getByRole('dialog')
        await dialog.getByLabel('名称', { exact: true }).fill('服务端拒绝的标题')
        await dialog.getByRole('button', { name: '保存修改' }).click()
        await dialog.getByRole('alert').getByText('公开收藏夹前需要先绑定 Wikidot 账号。').waitFor()
        assert.equal(await dialog.isVisible(), true)
      }
    )

    await scenario(
      browser,
      'collection-detail-error-clears-stale-actions',
      { linked: true, collectionDetailError: true },
      async (page, requests) => {
        await page.goto(`${baseUrl}/collections`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('heading', { name: 'SCP 精选', exact: true }).first().waitFor()

        const failedCollection = page.getByRole('button', { name: /待加载收藏夹/ })
        await failedCollection.click()
        await page.getByRole('alert').getByRole('heading', {
          name: '无法加载收藏夹详情'
        }).waitFor()

        assert.equal(await failedCollection.getAttribute('aria-pressed'), 'true')
        assert.equal(await page.getByRole('button', { name: '编辑', exact: true }).count(), 0)
        assert.equal(await page.getByRole('button', { name: '删除收藏夹' }).count(), 0)
        assert.equal(await page.getByRole('button', { name: /SCP 精选/ }).count(), 1)

        await page.getByRole('alert').getByRole('button', { name: '再试一次' }).click()
        await page.getByRole('alert').getByRole('heading', {
          name: '无法加载收藏夹详情'
        }).waitFor()
        assert.ok(
          requests.filter(entry => entry.path === '/collections/502').length >= 2,
          '详情失败后应保留明确的重试入口'
        )
      }
    )

    await scenario(
      browser,
      'collection-annotation-error-preserves-draft',
      { linked: true, collectionItemUpdateError: true },
      async (page, requests) => {
        await page.goto(`${baseUrl}/collections`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('heading', { name: 'SCP 精选', exact: true }).first().waitFor()

        const annotation = page.getByLabel('《SCP-CN-001》的批注', { exact: true })
        await annotation.fill('这段草稿不能因保存失败而消失')
        await page.keyboard.press('Tab')
        await page.getByRole('alert').getByText(
          '保存批注失败：批注服务暂时不可用 草稿仍保留在当前页面。',
          { exact: true }
        ).waitFor()

        assert.equal(
          await annotation.inputValue(),
          '这段草稿不能因保存失败而消失'
        )
        assert.equal(
          requests.filter(entry => (
            entry.path === '/collections/501/items/601' && entry.method === 'PATCH'
          )).length,
          1
        )
      }
    )

    await scenario(
      browser,
      'collection-item-refresh-preserves-interaction',
      { linked: true, collectionMutationFlow: true },
      async (page, requests) => {
        await page.goto(`${baseUrl}/collections`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('heading', { name: 'SCP 精选', exact: true }).first().waitFor()
        await page.getByText('SCP-CN-002', { exact: true }).waitFor()

        const detailRequest = request => (
          request.method() === 'GET'
          && new URL(request.url()).pathname === '/api/collections/501'
        )
        const annotation = page.getByLabel('《SCP-CN-001》的批注', { exact: true })
        await annotation.fill('失焦保存后仍要完成置顶操作')

        const pinButton = page.getByRole('button', { name: '取消置顶', exact: true })
        await pinButton.scrollIntoViewIfNeeded()
        const pinBox = await pinButton.boundingBox()
        assert.ok(pinBox, '置顶按钮应有可交互边界')

        const annotationDetailPromise = page.waitForRequest(detailRequest)
        const pinWritePromise = page.waitForRequest((request) => {
          if (
            request.method() !== 'PATCH'
            || new URL(request.url()).pathname !== '/api/collections/501/items/601'
          ) {
            return false
          }
          return request.postDataJSON()?.pinned === false
        })

        await page.mouse.move(pinBox.x + pinBox.width / 2, pinBox.y + pinBox.height / 2)
        await page.mouse.down()
        const annotationDetail = await annotationDetailPromise
        assert.equal(
          await page.getByRole('region', { name: 'SCP 精选 收藏夹详情' }).isVisible(),
          true,
          '批注刷新期间详情面板必须保持挂载'
        )
        assert.equal(
          await page.getByText('正在加载收藏夹详情…', { exact: true }).count(),
          0,
          '同一收藏夹静默刷新不应叠加整块 loading 面板'
        )

        const pinDetailPromise = page.waitForRequest(request => (
          detailRequest(request) && request !== annotationDetail
        ))
        await page.mouse.up()
        await pinWritePromise
        const pinDetail = await pinDetailPromise
        await pinDetail.response()

        const firstReorderPromise = page.waitForRequest((request) => {
          if (
            request.method() !== 'POST'
            || new URL(request.url()).pathname !== '/api/collections/501/items/reorder'
          ) {
            return false
          }
          return request.postDataJSON()?.order?.join(',') === '602,601'
        })
        const firstReorderDetailPromise = page.waitForRequest(detailRequest)
        await page.getByRole('button', { name: '将《SCP-CN-001》下移' }).click()
        await firstReorderPromise
        const firstReorderDetail = await firstReorderDetailPromise
        assert.equal(
          await page.getByRole('region', { name: 'SCP 精选 收藏夹详情' }).isVisible(),
          true,
          '排序刷新期间详情面板必须保持挂载'
        )
        await firstReorderDetail.response()

        const secondReorderPromise = page.waitForRequest((request) => {
          if (
            request.method() !== 'POST'
            || new URL(request.url()).pathname !== '/api/collections/501/items/reorder'
          ) {
            return false
          }
          return request.postDataJSON()?.order?.join(',') === '601,602'
        })
        const secondReorderDetailPromise = page.waitForRequest(detailRequest)
        await page.getByRole('button', { name: '将《SCP-CN-001》上移' }).click()
        await secondReorderPromise
        const secondReorderDetail = await secondReorderDetailPromise
        assert.equal(
          await page.getByRole('region', { name: 'SCP 精选 收藏夹详情' }).isVisible(),
          true
        )
        await secondReorderDetail.response()

        const itemWrites = requests.filter(entry => (
          entry.path === '/collections/501/items/601' && entry.method === 'PATCH'
        ))
        assert.deepEqual(
          itemWrites.map(entry => entry.body),
          [
            { annotation: '失焦保存后仍要完成置顶操作' },
            { pinned: false }
          ]
        )
        const reorderWrites = requests.filter(entry => (
          entry.path === '/collections/501/items/reorder' && entry.method === 'POST'
        ))
        assert.deepEqual(
          reorderWrites.map(entry => entry.body.order),
          [[602, 601], [601, 602]]
        )
      }
    )

    await scenario(
      browser,
      'collection-dialog-cannot-close-while-saving',
      { linked: true, delayCollectionWrite: 700 },
      async (page) => {
        await page.goto(`${baseUrl}/collections`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('heading', { name: 'SCP 精选', exact: true }).first().waitFor()
        await page.getByRole('button', { name: '编辑', exact: true }).first().click()
        const dialog = page.getByRole('dialog')
        await dialog.getByLabel('名称', { exact: true }).fill('保存中的标题')
        const saveButton = dialog.getByRole('button', { name: '保存修改' })
        await saveButton.click()
        await page.waitForTimeout(50)
        assert.equal(await saveButton.isDisabled(), true)
        await page.keyboard.press('Escape')
        assert.equal(await dialog.isVisible(), true)
        await dialog.waitFor({ state: 'detached' })
      }
    )

    await scenario(
      browser,
      'late-initial-auth-cannot-overwrite-login',
      { linked: true, switchAccount: true, delayInitialAuth: 900 },
      async (page) => {
        await page.goto(`${baseUrl}/auth/login`, { waitUntil: 'domcontentloaded' })
        await login(page)
        await page.getByText('second@example.com', { exact: true }).waitFor()
        await page.waitForTimeout(1100)
        assert.equal(await page.getByText('playwright@example.com', { exact: true }).count(), 0)
        assert.equal(await page.getByText('second@example.com', { exact: true }).count(), 1)
      }
    )

    await scenario(
      browser,
      'malformed-login-response-is-revalidated',
      { linked: true, switchAccount: true, malformedLogin: true },
      async (page, requests) => {
        await page.goto(`${baseUrl}/auth/login`, { waitUntil: 'domcontentloaded' })
        const authReadsBefore = requests.filter(entry => entry.path === '/auth/me').length
        await login(page)
        await page.getByText('second@example.com', { exact: true }).waitFor()
        assert.ok(
          requests.filter(entry => entry.path === '/auth/me').length > authReadsBefore,
          '畸形 login DTO 后必须通过 /auth/me 解析 Cookie 身份'
        )
        assert.equal(await page.getByText('playwright@example.com', { exact: true }).count(), 0)
      }
    )

    await scenario(
      browser,
      'cross-tab-account-switch-revalidates-before-write',
      { linked: true, switchAccount: true, delayAuthAfterSwitch: 800 },
      async (page, requests, context) => {
        await page.goto(`${baseUrl}/account/profile`, { waitUntil: 'domcontentloaded' })
        await page.getByText('playwright@example.com', { exact: true }).waitFor()

        const secondPage = await context.newPage()
        await secondPage.goto(`${baseUrl}/auth/login`, { waitUntil: 'domcontentloaded' })
        await login(secondPage)
        await secondPage.getByText('second@example.com', { exact: true }).waitFor()

        await page.getByText(/正在确认(?:当前账号|登录状态)/).waitFor()
        assert.equal(await page.getByText('playwright@example.com', { exact: true }).count(), 0)
        assert.equal(await page.getByLabel('昵称', { exact: true }).count(), 0)
        await page.getByText('second@example.com', { exact: true }).waitFor()
        const input = page.getByLabel('昵称', { exact: true })
        await input.fill('第二位用户的新昵称')
        await page.getByRole('button', { name: '保存昵称' }).click()
        await page.getByText('昵称已保存。', { exact: true }).waitFor()

        const writes = requests.filter(entry => entry.path === '/auth/profile' && entry.method === 'PATCH')
        assert.equal(writes.length, 1)
        assert.equal(writes[0].userId, 'pw-user-2')
        await secondPage.close()
      }
    )

    const staleWriteOptions = { linked: true, delayAuthAfterSwitch: 800 }
    await scenario(
      browser,
      'stale-account-write-is-rejected-by-user-boundary',
      staleWriteOptions,
      async (page, requests) => {
        await page.goto(`${baseUrl}/account/profile`, { waitUntil: 'domcontentloaded' })
        await page.getByText('playwright@example.com', { exact: true }).waitFor()
        await page.getByLabel('昵称', { exact: true }).fill('不应写给 B 的昵称')

        // 模拟另一标签页已把共享 Cookie 切到 B，但 storage/focus 通知尚未到达。
        staleWriteOptions.forceServerAccount = 'B'
        await page.getByRole('button', { name: '保存昵称' }).click()
        // 409 是本地身份快照已过期的信号；插件应立即通过不携带 expected-user
        // 的 /auth/me 重新解析 Cookie，而不是让用户在旧表单里反复失败。
        await page.getByText('second@example.com', { exact: true }).waitFor()
        await page.getByLabel('昵称', { exact: true }).waitFor()
        assert.equal(new URL(page.url()).pathname, '/account/profile')
        assert.equal(await page.getByRole('heading', { name: '账号登录' }).count(), 0)

        const writes = requests.filter(entry => entry.path === '/auth/profile')
        assert.equal(writes.length, 1)
        assert.equal(writes[0].expectedUserId, 'pw-user-1')
        assert.equal(writes[0].userId, 'pw-user-2')
        assert.equal(writes[0].rejected, true)
        assert.equal(await page.getByText('昵称已保存。', { exact: true }).count(), 0)
        assert.ok(requests.some(entry => entry.path === '/auth/me' && entry.userId === 'pw-user-2'))
      }
    )

    await scenario(
      browser,
      'same-tab-account-switch-isolates-collections',
      { linked: true, switchAccount: true },
      async (page) => {
        await page.goto(`${baseUrl}/collections`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('heading', { name: 'SCP 精选', exact: true }).first().waitFor()
        await page.goto(`${baseUrl}/auth/login`, { waitUntil: 'domcontentloaded' })
        await login(page)
        await page.getByText('second@example.com', { exact: true }).waitFor()
        await page.goto(`${baseUrl}/collections`, { waitUntil: 'domcontentloaded' })
        await page
          .getByRole('heading', { name: '第二位用户的收藏夹', exact: true })
          .first()
          .waitFor()
        assert.equal(await page.getByText('SCP 精选', { exact: true }).count(), 0)
      }
    )

    await scenario(
      browser,
      'unsafe-login-redirect-is-rejected',
      { linked: true, switchAccount: true },
      async (page) => {
        await page.goto(`${baseUrl}/auth/login?redirect=//evil.example`, {
          waitUntil: 'domcontentloaded'
        })
        await login(page)
        await page.getByText('second@example.com', { exact: true }).waitFor()
        assert.equal(new URL(page.url()).origin, new URL(baseUrl).origin)
        assert.equal(new URL(page.url()).pathname, '/account')
      }
    )
  } finally {
    await browser.close()
  }

  process.stdout.write(`PASS — screenshots: ${outputDir}\n`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
