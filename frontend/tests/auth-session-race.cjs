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

async function waitForNuxtHydration(page) {
  await page.waitForFunction(() => Boolean(document.querySelector('#__nuxt')?.__vue_app__))
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
    // Initial navigation also emits pageshow. A persisted pageshow represents
    // an actual bfcache foreground return and exercises the same production
    // callback without corrupting the page clock used by later debounce checks.
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
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
    if (!url.pathname.startsWith('/api/')) return route.continue()
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
  await waitForNuxtHydration(page)
  await page.getByText('race@example.com', { exact: true }).waitFor()
  await page.getByLabel('昵称', { exact: true }).waitFor()

  return { context, page, pageErrors }
}

async function verifyPassiveForegroundDoesNotEnterGlobalLoading(browser) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const pageErrors = []
  const foregroundReadStarted = deferred()
  const foregroundReadCompleted = deferred()
  const releaseForegroundRead = deferred()
  let delayNextAuthRead = false
  let authReadCount = 0

  page.on('pageerror', error => pageErrors.push(error))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const apiPath = url.pathname.slice('/api'.length)

    if (apiPath.startsWith('/avatar/')) {
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: transparentPng
      })
    }
    if (apiPath === '/auth/me' && request.method() === 'GET') {
      authReadCount += 1
      const shouldDelay = delayNextAuthRead
      delayNextAuthRead = false
      if (shouldDelay) {
        foregroundReadStarted.resolve()
        await releaseForegroundRead.promise
      }
      await fulfillJson(route, authUser('全局加载回归用户'))
      if (shouldDelay) foregroundReadCompleted.resolve()
      return
    }
    if (apiPath === '/ftml-projects' && request.method() === 'GET') {
      return fulfillJson(route, {
        projects: [{
          id: 'foreground-project-1',
          title: '前台恢复不能卸载的项目',
          pageTitle: null,
          pageTags: [],
          isArchived: false,
          createdAt: iso,
          updatedAt: iso
        }]
      })
    }
    if (apiPath === '/alerts') {
      return fulfillJson(route, { ok: true, alerts: [], unreadCount: 0 })
    }
    if (apiPath === '/alerts/forum' || apiPath === '/alerts/follow') {
      return fulfillJson(route, { ok: true, alerts: [], unreadCount: 0 })
    }
    await fulfillJson(route, { ok: false, error: `Unexpected API request: ${apiPath}` }, 404)
  })

  try {
    await page.goto(`${baseUrl}/ftml-projects`, { waitUntil: 'domcontentloaded' })
    await waitForNuxtHydration(page)
    const projectTitle = page.getByText('前台恢复不能卸载的项目', { exact: true })
    await projectTitle.waitFor()
    const documentState = await page.evaluate(() => {
      window.__ftmlForegroundDocumentToken = Math.random().toString(36)
      return {
        timeOrigin: performance.timeOrigin,
        navigationCount: performance.getEntriesByType('navigation').length,
        token: window.__ftmlForegroundDocumentToken,
        url: window.location.href
      }
    })
    await projectTitle.evaluate(element => {
      window.__ftmlProjectBeforeForeground = element.closest('.project-item')
    })

    delayNextAuthRead = true
    await dispatchForegroundEvent(page)
    await waitForSignal(foregroundReadStarted, 'FTML foreground /auth/me')

    assert.equal(authReadCount, 2)
    assert.equal(await page.getByText('正在验证登录状态...', { exact: true }).count(), 0)
    assert.equal(await projectTitle.count(), 1)
    assert.equal(
      await projectTitle.evaluate(element => (
        window.__ftmlProjectBeforeForeground === element.closest('.project-item')
      )),
      true,
      'passive validation must not replace an authenticated tool with its initial auth gate'
    )

    releaseForegroundRead.resolve()
    await waitForSignal(foregroundReadCompleted, 'FTML foreground /auth/me completion')
    await page.waitForTimeout(50)

    assert.equal(await page.getByText('正在验证登录状态...', { exact: true }).count(), 0)
    assert.equal(
      await projectTitle.evaluate(element => (
        window.__ftmlProjectBeforeForeground === element.closest('.project-item')
      )),
      true,
      'the authenticated tool must retain its DOM after passive validation completes'
    )
    assert.deepEqual(
      await page.evaluate(() => ({
        timeOrigin: performance.timeOrigin,
        navigationCount: performance.getEntriesByType('navigation').length,
        token: window.__ftmlForegroundDocumentToken,
        url: window.location.href
      })),
      documentState
    )
    assert.equal(pageErrors.length, 0, pageErrors.map(error => error.stack).join('\n'))
  } finally {
    releaseForegroundRead.resolve()
    await context.close()
  }
}

async function verifyForegroundIdentityChangeClearsPrivateView(browser) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const pageErrors = []
  const hardReadStarted = deferred()
  const releaseHardRead = deferred()
  const accountA = authIdentity('account-a', 'a@example.com', '账号 A')
  const accountB = authIdentity('account-b', 'b@example.com', '账号 B')
  let authReadCount = 0
  let projectReadCount = 0

  page.on('pageerror', error => pageErrors.push(error))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const apiPath = url.pathname.slice('/api'.length)

    if (apiPath.startsWith('/avatar/')) {
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: transparentPng
      })
    }
    if (apiPath === '/auth/me' && request.method() === 'GET') {
      authReadCount += 1
      if (authReadCount === 1) return fulfillJson(route, accountA)
      if (authReadCount === 2) return fulfillJson(route, accountB)
      if (authReadCount === 3) {
        hardReadStarted.resolve()
        await releaseHardRead.promise
      }
      return fulfillJson(route, accountB)
    }
    if (apiPath === '/ftml-projects' && request.method() === 'GET') {
      projectReadCount += 1
      const isAccountARead = projectReadCount === 1
      return fulfillJson(route, {
        projects: [{
          id: isAccountARead ? 'account-a-project' : 'account-b-project',
          title: isAccountARead ? '账号 A 的私有项目' : '账号 B 的私有项目',
          pageTitle: null,
          pageTags: [],
          isArchived: false,
          createdAt: iso,
          updatedAt: iso
        }]
      })
    }
    if (apiPath === '/alerts') {
      return fulfillJson(route, { ok: true, alerts: [], unreadCount: 0 })
    }
    if (apiPath === '/alerts/forum' || apiPath === '/alerts/follow') {
      return fulfillJson(route, { ok: true, alerts: [], unreadCount: 0 })
    }
    await fulfillJson(route, { ok: false, error: `Unexpected API request: ${apiPath}` }, 404)
  })

  try {
    await page.goto(`${baseUrl}/ftml-projects`, { waitUntil: 'domcontentloaded' })
    await waitForNuxtHydration(page)
    const accountAProject = page.getByText('账号 A 的私有项目', { exact: true })
    await accountAProject.waitFor()
    const documentState = await page.evaluate(() => {
      window.__identityChangeDocumentToken = Math.random().toString(36)
      return {
        timeOrigin: performance.timeOrigin,
        navigationCount: performance.getEntriesByType('navigation').length,
        token: window.__identityChangeDocumentToken,
        url: window.location.href
      }
    })

    await dispatchForegroundEvent(page)
    await waitForSignal(hardReadStarted, 'hard /auth/me after identity change')
    await page.getByText('正在验证登录状态...', { exact: true }).waitFor()

    assert.equal(authReadCount, 3)
    assert.equal(await accountAProject.count(), 0)
    assert.deepEqual(
      await page.evaluate(() => ({
        timeOrigin: performance.timeOrigin,
        navigationCount: performance.getEntriesByType('navigation').length,
        token: window.__identityChangeDocumentToken,
        url: window.location.href
      })),
      documentState,
      'identity invalidation must clear private UI without reloading the document'
    )

    releaseHardRead.resolve()
    await page.getByText('账号 B 的私有项目', { exact: true }).waitFor()

    assert.equal(projectReadCount, 2)
    assert.equal(await accountAProject.count(), 0)
    assert.equal(pageErrors.length, 0, pageErrors.map(error => error.stack).join('\n'))
  } finally {
    releaseHardRead.resolve()
    await context.close()
  }
}

async function verifyForegroundProfileUpdatePreservesDraft(browser) {
  const foregroundReadStarted = deferred()
  const foregroundReadCompleted = deferred()
  const releaseForegroundRead = deferred()
  let authReadCount = 0
  let delayNextAuthRead = false

  const { context, page, pageErrors } = await prepareProfilePage(
    browser,
    async (route, apiPath, request) => {
      if (apiPath === '/auth/me' && request.method() === 'GET') {
        authReadCount += 1
        const shouldDelay = delayNextAuthRead
        delayNextAuthRead = false
        if (shouldDelay) {
          foregroundReadStarted.resolve()
          await releaseForegroundRead.promise
        }
        await fulfillJson(route, authUser(shouldDelay ? '其他标签页的新昵称' : '服务端旧昵称'))
        if (shouldDelay) foregroundReadCompleted.resolve()
        return true
      }
      return false
    }
  )

  try {
    const profileInput = page.getByLabel('昵称', { exact: true })
    await profileInput.fill('不能被覆盖的本地草稿')
    await profileInput.evaluate(input => {
      window.__profileDraftInputBeforeForeground = input
    })

    delayNextAuthRead = true
    await dispatchForegroundEvent(page)
    await waitForSignal(foregroundReadStarted, 'profile update foreground /auth/me')
    releaseForegroundRead.resolve()
    await waitForSignal(foregroundReadCompleted, 'profile update foreground /auth/me completion')
    await page.waitForTimeout(50)

    assert.equal(authReadCount, 2)
    assert.equal(await profileInput.inputValue(), '不能被覆盖的本地草稿')
    assert.equal(
      await page.evaluate(() => (
        window.__profileDraftInputBeforeForeground
        === document.querySelector('#account-display-name')
      )),
      true,
      'same-account profile refresh must keep the existing input mounted'
    )
    await page.getByRole('button', { name: '撤销更改', exact: true }).click()
    assert.equal(
      await profileInput.inputValue(),
      '其他标签页的新昵称',
      'undo must reveal the server snapshot applied by passive validation'
    )
    assert.equal(pageErrors.length, 0, pageErrors.map(error => error.stack).join('\n'))
  } finally {
    releaseForegroundRead.resolve()
    await context.close()
  }
}

async function verifyProfileRouteRoundTripPreservesDraft(browser) {
  let authReadCount = 0
  const { context, page, pageErrors } = await prepareProfilePage(
    browser,
    async (route, apiPath, request) => {
      if (apiPath === '/auth/me' && request.method() === 'GET') {
        authReadCount += 1
        await fulfillJson(route, authUser('往返路由服务端昵称'))
        return true
      }
      return false
    }
  )

  try {
    const profileInput = page.getByLabel('昵称', { exact: true })
    await profileInput.fill('跨账号子页保留的草稿')
    const documentState = await page.evaluate(() => {
      window.__profileRoundTripDocumentToken = Math.random().toString(36)
      return {
        timeOrigin: performance.timeOrigin,
        navigationCount: performance.getEntriesByType('navigation').length,
        token: window.__profileRoundTripDocumentToken
      }
    })

    await page.getByRole('link', { name: /账号连接/ }).first().click()
    await page.getByRole('heading', { name: 'Wikidot 身份', exact: true }).waitFor()
    await page.goBack()
    await page.getByLabel('昵称', { exact: true }).waitFor()

    assert.equal(await page.getByLabel('昵称', { exact: true }).inputValue(), '跨账号子页保留的草稿')
    assert.equal(authReadCount, 1, 'SPA route round-trip must reuse the resolved auth snapshot')
    assert.deepEqual(
      await page.evaluate(() => ({
        timeOrigin: performance.timeOrigin,
        navigationCount: performance.getEntriesByType('navigation').length,
        token: window.__profileRoundTripDocumentToken
      })),
      documentState
    )
    assert.equal(pageErrors.length, 0, pageErrors.map(error => error.stack).join('\n'))
  } finally {
    await context.close()
  }
}

async function verifyNormalizedProfileSaveClearsDraft(browser) {
  const remoteReadStarted = deferred()
  const remoteReadCompleted = deferred()
  const releaseRemoteRead = deferred()
  let displayName = '规范化前昵称'
  let delayNextAuthRead = false
  let authReadCount = 0
  const submittedNames = []

  const { context, page, pageErrors } = await prepareProfilePage(
    browser,
    async (route, apiPath, request) => {
      if (apiPath === '/auth/me' && request.method() === 'GET') {
        authReadCount += 1
        const shouldDelay = delayNextAuthRead
        delayNextAuthRead = false
        if (shouldDelay) {
          remoteReadStarted.resolve()
          await releaseRemoteRead.promise
        }
        await fulfillJson(route, authUser(displayName))
        if (shouldDelay) remoteReadCompleted.resolve()
        return true
      }
      if (apiPath === '/auth/profile' && request.method() === 'PATCH') {
        const submittedName = request.postDataJSON().displayName
        submittedNames.push(submittedName)
        displayName = submittedName.trim()
        await fulfillJson(route, authUser(displayName))
        return true
      }
      return false
    }
  )

  try {
    const profileInput = page.getByLabel('昵称', { exact: true })
    await profileInput.fill('  已规范化昵称  ')
    await page.getByRole('button', { name: '保存昵称', exact: true }).click()
    await page.getByText('昵称已保存。', { exact: true }).waitFor()

    assert.deepEqual(submittedNames, ['已规范化昵称'])
    assert.equal(await profileInput.inputValue(), '已规范化昵称')

    await page.getByRole('link', { name: /账号连接/ }).first().click()
    await page.getByRole('heading', { name: 'Wikidot 身份', exact: true }).waitFor()
    await page.goBack()
    await page.getByLabel('昵称', { exact: true }).waitFor()
    assert.equal(
      await page.getByLabel('昵称', { exact: true }).inputValue(),
      '已规范化昵称',
      'a successful canonical save must not restore its raw whitespace draft'
    )

    displayName = '其他标签页后续昵称'
    delayNextAuthRead = true
    await dispatchForegroundEvent(page)
    await waitForSignal(remoteReadStarted, 'post-save foreground /auth/me')
    releaseRemoteRead.resolve()
    await waitForSignal(remoteReadCompleted, 'post-save foreground /auth/me completion')
    await page.getByLabel('昵称', { exact: true }).waitFor({
      state: 'visible'
    })
    await page.waitForFunction(() => (
      document.querySelector('#account-display-name')?.value === '其他标签页后续昵称'
    ))

    assert.equal(authReadCount, 2)
    assert.equal(pageErrors.length, 0, pageErrors.map(error => error.stack).join('\n'))
  } finally {
    releaseRemoteRead.resolve()
    await context.close()
  }
}

async function verifyProfileSavingSurvivesRouteRemount(browser) {
  const profileWriteStarted = deferred()
  const releaseProfileWrite = deferred()
  let displayName = '保存状态服务端昵称'
  let profileWriteCount = 0

  const { context, page, pageErrors } = await prepareProfilePage(
    browser,
    async (route, apiPath, request) => {
      if (apiPath === '/auth/me' && request.method() === 'GET') {
        await fulfillJson(route, authUser(displayName))
        return true
      }
      if (apiPath === '/auth/profile' && request.method() === 'PATCH') {
        profileWriteCount += 1
        const submittedName = request.postDataJSON().displayName
        profileWriteStarted.resolve()
        await releaseProfileWrite.promise
        displayName = submittedName
        await fulfillJson(route, authUser(displayName))
        return true
      }
      return false
    }
  )

  try {
    await page.getByLabel('昵称', { exact: true }).fill('路由往返中的在途保存')
    await page.getByRole('button', { name: '保存昵称', exact: true }).click()
    await waitForSignal(profileWriteStarted, 'profile write before route remount')

    await page.getByRole('link', { name: /账号连接/ }).first().click()
    await page.getByRole('heading', { name: 'Wikidot 身份', exact: true }).waitFor()
    await page.goBack()

    const remountedInput = page.getByLabel('昵称', { exact: true })
    const remountedSave = page.getByRole('button', { name: '保存中…', exact: true })
    await remountedInput.waitFor()
    assert.equal(await remountedInput.isDisabled(), true)
    assert.equal(await remountedSave.isDisabled(), true)

    // Even a programmatic submit from the remounted form must not start a
    // second PATCH while the first request still owns this user's save state.
    await page.evaluate(() => {
      document.querySelector('#account-display-name')
        ?.closest('form')
        ?.requestSubmit()
    })
    await page.waitForTimeout(100)
    assert.equal(profileWriteCount, 1)

    releaseProfileWrite.resolve()
    await page.waitForFunction(() => (
      document.querySelector('#account-display-name')?.disabled === false
    ))
    assert.equal(await remountedInput.inputValue(), '路由往返中的在途保存')
    assert.equal(profileWriteCount, 1)
    assert.equal(pageErrors.length, 0, pageErrors.map(error => error.stack).join('\n'))
  } finally {
    releaseProfileWrite.resolve()
    await context.close()
  }
}

async function verifyProfileFailureSurvivesRouteRemount(browser) {
  const profileWriteStarted = deferred()
  const releaseProfileWrite = deferred()
  let profileWriteCount = 0

  const { context, page, pageErrors } = await prepareProfilePage(
    browser,
    async (route, apiPath, request) => {
      if (apiPath === '/auth/me' && request.method() === 'GET') {
        await fulfillJson(route, authUser('失败反馈服务端昵称'))
        return true
      }
      if (apiPath === '/auth/profile' && request.method() === 'PATCH') {
        profileWriteCount += 1
        profileWriteStarted.resolve()
        await releaseProfileWrite.promise
        await fulfillJson(route, { ok: false, error: '跨路由保存失败' }, 503)
        return true
      }
      return false
    }
  )

  try {
    await page.getByLabel('昵称', { exact: true }).fill('失败后必须保留的草稿')
    await page.getByRole('button', { name: '保存昵称', exact: true }).click()
    await waitForSignal(profileWriteStarted, 'failing profile write before route remount')

    await page.getByRole('link', { name: /账号连接/ }).first().click()
    await page.getByRole('heading', { name: 'Wikidot 身份', exact: true }).waitFor()
    await page.goBack()

    const remountedInput = page.getByLabel('昵称', { exact: true })
    await remountedInput.waitFor()
    assert.equal(await remountedInput.isDisabled(), true)
    assert.equal(
      await page.getByRole('button', { name: '保存中…', exact: true }).isDisabled(),
      true
    )

    releaseProfileWrite.resolve()
    await page.getByText('跨路由保存失败', { exact: true }).waitFor()

    assert.equal(await remountedInput.isEnabled(), true)
    assert.equal(await remountedInput.inputValue(), '失败后必须保留的草稿')
    assert.equal(profileWriteCount, 1)
    assert.equal(pageErrors.length, 0, pageErrors.map(error => error.stack).join('\n'))
  } finally {
    releaseProfileWrite.resolve()
    await context.close()
  }
}

async function verifyResolvedGateStaysStableOnForeground(
  browser,
  {
    label,
    heading,
    responseBody,
    responseStatus,
    foregroundResponseBody = responseBody,
    foregroundResponseStatus = responseStatus
  }
) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const pageErrors = []
  const delayedReadStarted = deferred()
  const delayedReadCompleted = deferred()
  const releaseDelayedRead = deferred()
  let delayNextAuthRead = false

  page.on('pageerror', error => pageErrors.push(error))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const apiPath = url.pathname.slice('/api'.length)
    if (apiPath === '/auth/me' && request.method() === 'GET') {
      const shouldDelay = delayNextAuthRead
      delayNextAuthRead = false
      if (shouldDelay) {
        delayedReadStarted.resolve()
        await releaseDelayedRead.promise
      }
      await fulfillJson(
        route,
        shouldDelay ? foregroundResponseBody : responseBody,
        shouldDelay ? foregroundResponseStatus : responseStatus
      )
      if (shouldDelay) delayedReadCompleted.resolve()
      return
    }
    await fulfillJson(route, { ok: false, error: `Unexpected API request: ${apiPath}` }, 404)
  })

  try {
    await page.goto(`${baseUrl}/account`, { waitUntil: 'domcontentloaded' })
    await waitForNuxtHydration(page)
    const gateHeading = page.getByRole('heading', { name: heading, exact: true })
    await gateHeading.waitFor()
    const documentState = await page.evaluate(() => {
      window.__accountGateDocumentToken = Math.random().toString(36)
      return {
        timeOrigin: performance.timeOrigin,
        navigationCount: performance.getEntriesByType('navigation').length,
        token: window.__accountGateDocumentToken,
        url: window.location.href
      }
    })
    await gateHeading.evaluate(element => {
      window.__accountGateBeforeForeground = element.closest('section')
    })

    delayNextAuthRead = true
    await dispatchForegroundEvent(page)
    await waitForSignal(delayedReadStarted, `${label} foreground /auth/me`)

    assert.equal(await gateHeading.count(), 1)
    assert.equal(await page.getByText('正在确认登录状态…', { exact: true }).count(), 0)
    assert.equal(
      await gateHeading.evaluate(element => (
        window.__accountGateBeforeForeground === element.closest('section')
      )),
      true,
      `${label} gate must remain mounted while passive validation is pending`
    )

    releaseDelayedRead.resolve()
    await waitForSignal(delayedReadCompleted, `${label} foreground /auth/me completion`)
    await page.waitForTimeout(50)

    assert.equal(await gateHeading.count(), 1)
    assert.equal(
      await gateHeading.evaluate(element => (
        window.__accountGateBeforeForeground === element.closest('section')
      )),
      true,
      `${label} gate must remain mounted after passive validation completes`
    )
    assert.deepEqual(
      await page.evaluate(() => ({
        timeOrigin: performance.timeOrigin,
        navigationCount: performance.getEntriesByType('navigation').length,
        token: window.__accountGateDocumentToken,
        url: window.location.href
      })),
      documentState
    )
    assert.equal(pageErrors.length, 0, pageErrors.map(error => error.stack).join('\n'))
  } finally {
    releaseDelayedRead.resolve()
    await context.close()
  }
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
    const profileInput = page.getByLabel('昵称', { exact: true })
    await profileInput.fill('写入接管慢验证')
    const documentTimeOrigin = await page.evaluate(() => performance.timeOrigin)
    await profileInput.evaluate(input => {
      window.__accountProfileInputBeforeForeground = input
    })
    delayNextAuthRead = true
    // Playwright 的无头模式不会稳定更新真实标签页的 document.hidden，
    // 直接派发同一 foreground 回调依赖的 pageshow 事件来覆盖该路径。
    await dispatchForegroundEvent(page)
    await waitForSignal(slowGetStarted, 'foreground /auth/me')

    const verifyingStatus = page.getByText('正在确认当前账号…', { exact: true })
    assert.equal(
      await verifyingStatus.count(),
      0,
      'passive foreground validation must not cover the account page'
    )
    assert.equal(await profileInput.isEnabled(), true)
    assert.equal(await profileInput.inputValue(), '写入接管慢验证')
    assert.equal(
      await page.evaluate(() => (
        window.__accountProfileInputBeforeForeground
        === document.querySelector('#account-display-name')
      )),
      true,
      'passive foreground validation must keep the existing account form mounted'
    )
    assert.equal(await page.evaluate(() => performance.timeOrigin), documentTimeOrigin)

    await page.getByRole('button', { name: '保存昵称' }).click()
    await waitForSignal(postStarted, 'profile POST taking over session validation')

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
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const apiPath = url.pathname.slice('/api'.length)

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
    await waitForNuxtHydration(page)
    // Wait for the initial /auth/me result to finish hydrating the shared
    // layout before typing; otherwise dev-mode Suspense can replace the inputs
    // after Playwright fills them.
    await page.getByRole('link', { name: '登录', exact: true }).first().waitFor()
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
    await verifyPassiveForegroundDoesNotEnterGlobalLoading(browser)
    process.stdout.write('PASS passive foreground validation does not enter global auth loading\n')
    await verifyForegroundIdentityChangeClearsPrivateView(browser)
    process.stdout.write('PASS foreground identity change clears private view before switching accounts\n')
    await verifyForegroundProfileUpdatePreservesDraft(browser)
    process.stdout.write('PASS foreground same-account profile update preserves local draft\n')
    await verifyProfileRouteRoundTripPreservesDraft(browser)
    process.stdout.write('PASS profile route round-trip preserves local draft\n')
    await verifyNormalizedProfileSaveClearsDraft(browser)
    process.stdout.write('PASS normalized profile save clears its persisted draft\n')
    await verifyProfileSavingSurvivesRouteRemount(browser)
    process.stdout.write('PASS profile saving state survives route remount\n')
    await verifyProfileFailureSurvivesRouteRemount(browser)
    process.stdout.write('PASS profile save failure survives route remount\n')
    await verifyResolvedGateStaysStableOnForeground(browser, {
      label: 'unauthenticated',
      heading: '登录后继续',
      responseBody: { ok: false, error: '未登录' },
      responseStatus: 401
    })
    process.stdout.write('PASS unauthenticated gate stays stable during foreground validation\n')
    await verifyResolvedGateStaysStableOnForeground(browser, {
      label: 'unauthenticated transient error',
      heading: '登录后继续',
      responseBody: { ok: false, error: '未登录' },
      responseStatus: 401,
      foregroundResponseBody: { ok: false, error: '认证服务暂时不可用' },
      foregroundResponseStatus: 503
    })
    process.stdout.write('PASS passive foreground error preserves resolved unauthenticated gate\n')
    await verifyResolvedGateStaysStableOnForeground(browser, {
      label: 'error',
      heading: '暂时无法读取账号信息',
      responseBody: { ok: false, error: '认证服务暂时不可用' },
      responseStatus: 503
    })
    process.stdout.write('PASS error gate stays stable during foreground validation\n')
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
