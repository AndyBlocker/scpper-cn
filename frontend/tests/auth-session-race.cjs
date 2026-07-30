const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const baseUrl = process.env.ACCOUNT_TEST_BASE_URL || 'http://127.0.0.1:19876'
const iso = '2026-07-30T08:00:00.000Z'
const transparentPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64'
)

function deferred() {
  let resolve
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitForSignal(signal, label) {
  let timer
  try {
    await Promise.race([
      signal.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function authUser(displayName) {
  return authIdentity('race-user-1', 'race@example.com', displayName)
}

function authIdentity(id, email, displayName) {
  return {
    ok: true,
    user: {
      id,
      email,
      displayName,
      linkedWikidotId: 123456,
      lastLoginAt: iso,
      qqBinding: {
        bound: false,
        addressMask: null,
        status: null,
        pendingChallenge: false,
        capabilities: {
          featureEnabled: false,
          createBinding: false,
          deliverNotifications: false,
          manageExistingBinding: false
        }
      }
    }
  }
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body)
  })
}

async function dispatchForegroundEvent(page) {
  await page.evaluate(() => {
    // 将这一次事件移出应用内部的 1 秒防抖窗口，避免浏览器自身 pageshow/focus
    // 调度时机让竞态测试偶发地只测到 debounce。
    const realDateNow = Date.now
    Date.now = () => realDateNow() + 60_000
    try {
      window.dispatchEvent(new Event('pageshow'))
    } finally {
      Date.now = realDateNow
    }
  })
}

async function prepareProfilePage(browser, apiHandler) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error))

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const apiPath = url.pathname.slice('/api'.length)

    if (apiPath.startsWith('/avatar/')) {
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: transparentPng
      })
    }
    if (apiPath === '/wikidot-binding/status') {
      return fulfillJson(route, { ok: true, task: null })
    }

    const handled = await apiHandler(route, apiPath, request)
    if (!handled) {
      await fulfillJson(route, { ok: false, error: `Unexpected API request: ${apiPath}` }, 404)
    }
  })

  await page.goto(`${baseUrl}/account/profile`, { waitUntil: 'domcontentloaded' })
  await page.getByText('race@example.com', { exact: true }).waitFor()
  await page.getByLabel('昵称', { exact: true }).waitFor()

  return { context, page, pageErrors }
}

async function verifyPassiveForegroundCannotSupersedeMutation(browser) {
  const postStarted = deferred()
  const releasePost = deferred()
  const queuedValidationStarted = deferred()
  let displayName = '竞态测试用户'
  let profilePending = false
  let authReadsDuringMutation = 0
  let expectQueuedValidation = false

  const { context, page, pageErrors } = await prepareProfilePage(
    browser,
    async (route, apiPath, request) => {
      if (apiPath === '/auth/me' && request.method() === 'GET') {
        if (profilePending) {
          authReadsDuringMutation += 1
        } else if (expectQueuedValidation) {
          queuedValidationStarted.resolve()
        }
        await fulfillJson(route, authUser(displayName))
        return true
      }
      if (apiPath === '/auth/profile' && request.method() === 'PATCH') {
        profilePending = true
        postStarted.resolve()
        await releasePost.promise
        displayName = request.postDataJSON().displayName
        profilePending = false
        await fulfillJson(route, authUser(displayName))
        return true
      }
      return false
    }
  )

  try {
    await page.getByLabel('昵称', { exact: true }).fill('慢写入应当获胜')
    await page.getByRole('button', { name: '保存昵称' }).click()
    await waitForSignal(postStarted, 'profile POST')

    expectQueuedValidation = true
    await dispatchForegroundEvent(page)
    await page.waitForTimeout(150)

    assert.equal(
      authReadsDuringMutation,
      0,
      'passive foreground validation must not start /auth/me during an identity mutation'
    )

    releasePost.resolve()
    await page.getByText('昵称已保存。', { exact: true }).waitFor()
    await waitForSignal(queuedValidationStarted, 'queued foreground /auth/me')
    assert.equal(
      await page.getByLabel('昵称', { exact: true }).inputValue(),
      '慢写入应当获胜'
    )
    assert.equal(pageErrors.length, 0, pageErrors.map(error => error.stack).join('\n'))
  } finally {
    releasePost.resolve()
    await context.close()
  }
}

async function verifyMutationTakesOverSlowValidation(browser) {
  const slowGetStarted = deferred()
  const releaseSlowGet = deferred()
  const postStarted = deferred()
  const releasePost = deferred()
  let displayName = '竞态测试用户'
  let delayNextAuthRead = false

  const { context, page, pageErrors } = await prepareProfilePage(
    browser,
    async (route, apiPath, request) => {
      if (apiPath === '/auth/me' && request.method() === 'GET') {
        const responseSnapshot = displayName
        if (delayNextAuthRead) {
          delayNextAuthRead = false
          slowGetStarted.resolve()
          await releaseSlowGet.promise
        }
        await fulfillJson(route, authUser(responseSnapshot))
        return true
      }
      if (apiPath === '/auth/profile' && request.method() === 'PATCH') {
        const submittedName = request.postDataJSON().displayName
        postStarted.resolve()
        await releasePost.promise
        displayName = submittedName
        await fulfillJson(route, authUser(displayName))
        return true
      }
      return false
    }
  )

  try {
    await page.getByLabel('昵称', { exact: true }).fill('写入接管慢验证')
    delayNextAuthRead = true
    await dispatchForegroundEvent(page)
    await waitForSignal(slowGetStarted, 'foreground /auth/me')

    const verifyingStatus = page.getByText('正在确认当前账号…', { exact: true })
    await verifyingStatus.waitFor()

    // AccountAuthGate 在验证期间会让表单 inert；直接派发 submit 模拟已经进入
    // Vue 事件队列的 mutation，验证 composable 的状态接管，而不是浏览器点击行为。
    await page.getByLabel('昵称', { exact: true }).evaluate(input => {
      input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await waitForSignal(postStarted, 'profile POST taking over session validation')

    // 慢 GET 尚未释放；mutation 开始后必须立即撤销旧验证的 overlay/inert 所有权。
    await verifyingStatus.waitFor({ state: 'hidden', timeout: 1_000 })

    releasePost.resolve()
    await page.getByText('昵称已保存。', { exact: true }).waitFor()

    releaseSlowGet.resolve()
    await page.waitForTimeout(150)
    assert.equal(
      await page.getByLabel('昵称', { exact: true }).inputValue(),
      '写入接管慢验证',
      'superseded validation response must not restore its stale profile snapshot'
    )
    assert.equal(await verifyingStatus.count(), 0)
    assert.equal(pageErrors.length, 0, pageErrors.map(error => error.stack).join('\n'))
  } finally {
    releasePost.resolve()
    releaseSlowGet.resolve()
    await context.close()
  }
}

async function verifySupersededLoginRevalidatesFinalCookie(browser) {
  const loginStarted = deferred()
  const releaseLogin = deferred()
  const externalValidationCompleted = deferred()
  const accountB1 = authIdentity('account-b1', 'b1@example.com', '最终账号 B1')
  const accountB2 = authIdentity('account-b2', 'b2@example.com', '外部账号 B2')
  let cookieIdentity = null
  let b1AuthReads = 0

  const context = await browser.newContext()
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error))

  await page.route('**/api/**', async route => {
    const request = route.request()
    const apiPath = new URL(request.url()).pathname.slice('/api'.length)

    if (apiPath === '/auth/me' && request.method() === 'GET') {
      if (!cookieIdentity) {
        return fulfillJson(route, { ok: false, error: '未登录' }, 401)
      }
      if (cookieIdentity.user.id === accountB1.user.id) {
        b1AuthReads += 1
      }
      await fulfillJson(route, cookieIdentity)
      if (cookieIdentity.user.id === accountB2.user.id) {
        externalValidationCompleted.resolve()
      }
      return
    }
    if (apiPath === '/auth/login' && request.method() === 'POST') {
      loginStarted.resolve()
      await releaseLogin.promise
      // 模拟慢登录响应在另一标签页验证完成后才写 Set-Cookie。
      cookieIdentity = accountB1
      await fulfillJson(route, accountB1)
      return
    }
    return fulfillJson(route, { ok: false, error: `Unexpected API request: ${apiPath}` }, 404)
  })

  try {
    await page.goto(`${baseUrl}/auth/login`, { waitUntil: 'domcontentloaded' })
    await page.getByLabel('邮箱', { exact: true }).fill('b1@example.com')
    await page.getByLabel('密码', { exact: true }).fill('password-for-race-test')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await waitForSignal(loginStarted, 'slow login POST')

    cookieIdentity = accountB2
    await page.evaluate(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'scpper:auth-session-version',
        newValue: JSON.stringify({
          sourceId: 'another-tab',
          reason: 'login',
          nonce: 'external-login'
        })
      }))
    })
    await waitForSignal(externalValidationCompleted, 'external account validation')
    await page.getByText('外部账号 B2', { exact: true }).waitFor()

    releaseLogin.resolve()
    await page.getByText('最终账号 B1', { exact: true }).waitFor()
    assert.ok(b1AuthReads >= 1, 'late login cookie must be re-read after supersession')
    assert.equal(pageErrors.length, 0, pageErrors.map(error => error.stack).join('\n'))
  } finally {
    releaseLogin.resolve()
    await context.close()
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  try {
    await verifyPassiveForegroundCannotSupersedeMutation(browser)
    process.stdout.write('PASS passive foreground validation yields to identity mutation\n')
    await verifyMutationTakesOverSlowValidation(browser)
    process.stdout.write('PASS identity mutation takes over slow session validation\n')
    await verifySupersededLoginRevalidatesFinalCookie(browser)
    process.stdout.write('PASS superseded login revalidates the final cookie identity\n')
  } finally {
    await browser.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
