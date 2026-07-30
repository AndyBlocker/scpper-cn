const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const baseUrl = process.env.ACCOUNT_TEST_BASE_URL || 'http://127.0.0.1:19876'
const iso = '2026-07-30T08:00:00.000Z'
const projectId = 'shared-project'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function requestGate() {
  return {
    started: deferred(),
    release: deferred()
  }
}

function account(id, name, wikidotId) {
  return {
    id,
    email: `${id}@example.com`,
    displayName: name,
    linkedWikidotId: wikidotId,
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

const accountA = account('ftml-account-a', 'FTML 账号 A', 101001)
const accountB = account('ftml-account-b', 'FTML 账号 B', 202002)

const sources = {
  [accountA.id]: [
    '++ A-ONLY-PRIVATE-SOURCE',
    '',
    '这是账号 A 的完整私有源码。',
    '[[div class="account-a-secret"]]',
    'A_SECRET_END_MARKER',
    '[[/div]]'
  ].join('\n'),
  [accountB.id]: [
    '++ B-ONLY-PRIVATE-SOURCE',
    '',
    '这是账号 B 的完整私有源码。',
    '[[div class="account-b-secret"]]',
    'B_SECRET_END_MARKER',
    '[[/div]]'
  ].join('\n')
}

function titleFor(ownerId) {
  return ownerId === accountA.id ? '账号 A 的私有 FTML 项目' : '账号 B 的私有 FTML 项目'
}

function projectFor(ownerId) {
  return {
    id: projectId,
    title: titleFor(ownerId),
    pageTitle: null,
    pageTags: ownerId === accountA.id ? ['account-a'] : ['account-b'],
    isArchived: false,
    createdAt: iso,
    updatedAt: iso,
    source: sources[ownerId],
    settings: {
      mode: 'page',
      layout: 'wikidot',
      includeMode: 'disabled',
      uiLayout: 'both',
      previewDevice: 'desktop'
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

async function waitForSignal(signal, label) {
  await Promise.race([
    signal.promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000)
    })
  ])
}

async function createHarness(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const pageErrors = []
  const ftmlRequests = []
  page.on('pageerror', error => pageErrors.push(error))

  let cookieAccount = accountA
  let nextAuthGate = null
  const nextListGate = new Map()
  const nextDetailGate = new Map()
  const nextCreateGate = new Map()
  const nextSaveGate = new Map()

  async function consumeGate(map, ownerId, label) {
    const gate = map.get(ownerId)
    if (!gate) return
    map.delete(ownerId)
    gate.started.resolve()
    await gate.release.promise
    return label
  }

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const apiPath = url.pathname.slice('/api'.length)
    const method = request.method()

    if (apiPath === '/auth/me') {
      const responseAccount = cookieAccount
      const gate = nextAuthGate
      nextAuthGate = null
      if (gate) {
        gate.started.resolve()
        await gate.release.promise
      }
      return fulfillJson(route, { ok: true, user: responseAccount })
    }

    if (apiPath.startsWith('/ftml-projects')) {
      const expected = request.headers()['x-scpper-expected-user-id'] || null
      ftmlRequests.push({ method, path: apiPath, expected })
      if (!expected) {
        return fulfillJson(route, { error: 'missing_expected_user' }, 400)
      }

      if (apiPath === '/ftml-projects' && method === 'GET') {
        await consumeGate(nextListGate, expected, 'list')
        const project = projectFor(expected)
        const { source: _source, settings: _settings, ...meta } = project
        return fulfillJson(route, { projects: [meta] })
      }

      if (apiPath === '/ftml-projects' && method === 'POST') {
        await consumeGate(nextCreateGate, expected, 'create')
        return fulfillJson(route, {
          project: {
            ...projectFor(expected),
            id: `${expected}-created`,
            title: '未命名项目'
          }
        })
      }

      if (apiPath === `/ftml-projects/${projectId}` && method === 'GET') {
        await consumeGate(nextDetailGate, expected, 'detail')
        return fulfillJson(route, { project: projectFor(expected) })
      }

      if (apiPath === `/ftml-projects/${projectId}` && method === 'PATCH') {
        await consumeGate(nextSaveGate, expected, 'save')
        const body = request.postDataJSON()
        return fulfillJson(route, {
          project: {
            ...projectFor(expected),
            ...body,
            id: projectId,
            updatedAt: iso
          }
        })
      }
    }

    return fulfillJson(route, { ok: false, error: `Unexpected API request: ${method} ${apiPath}` }, 404)
  })

  async function switchAccount(nextAccount, options = {}) {
    cookieAccount = nextAccount
    const authGate = options.holdAuth ? requestGate() : null
    nextAuthGate = authGate
    await page.evaluate(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'scpper:auth-session-version',
        newValue: JSON.stringify({
          sourceId: 'ftml-race-other-tab',
          reason: 'login',
          nonce: `${Date.now()}-${Math.random()}`
        })
      }))
    })
    return authGate
  }

  return {
    context,
    page,
    pageErrors,
    ftmlRequests,
    switchAccount,
    holdNextList(ownerId) {
      const gate = requestGate()
      nextListGate.set(ownerId, gate)
      return gate
    },
    holdNextDetail(ownerId) {
      const gate = requestGate()
      nextDetailGate.set(ownerId, gate)
      return gate
    },
    holdNextCreate(ownerId) {
      const gate = requestGate()
      nextCreateGate.set(ownerId, gate)
      return gate
    },
    holdNextSave(ownerId) {
      const gate = requestGate()
      nextSaveGate.set(ownerId, gate)
      return gate
    }
  }
}

async function waitForEditorSource(page, expectedSource) {
  await page.waitForFunction(source => {
    const textarea = document.querySelector('textarea.editor-textarea')
    return textarea instanceof HTMLTextAreaElement && textarea.value === source
  }, expectedSource)
  assert.equal(await page.locator('textarea.editor-textarea').inputValue(), expectedSource)
}

async function assertNoPageErrors(harness) {
  assert.equal(
    harness.pageErrors.length,
    0,
    harness.pageErrors.map(error => error.stack || error.message).join('\n')
  )
}

async function testSettledListAndStaleCreate(browser) {
  const harness = await createHarness(browser)
  const { page } = harness
  try {
    await page.goto(`${baseUrl}/ftml-projects`, { waitUntil: 'domcontentloaded' })
    await page.getByText(titleFor(accountA.id), { exact: true }).waitFor()

    // A 已经落到页面后，身份验证一开始就必须同步清掉 A，不能等 B 的响应。
    const authGate = await harness.switchAccount(accountB, { holdAuth: true })
    await waitForSignal(authGate.started, 'held B auth request')
    await page.waitForFunction(secret => !document.body.innerText.includes(secret), titleFor(accountA.id))
    authGate.release.resolve()
    await page.getByText(titleFor(accountB.id), { exact: true }).waitFor()

    // 回到 A 发起 create，再切到 B。A 的旧成功响应不得把页面导航到 A 的项目。
    await harness.switchAccount(accountA)
    await page.getByText(titleFor(accountA.id), { exact: true }).waitFor()
    const createGate = harness.holdNextCreate(accountA.id)
    await page.getByRole('button', { name: '新建项目', exact: true }).first().click()
    await waitForSignal(createGate.started, 'held A create request')

    await harness.switchAccount(accountB)
    await page.getByText(titleFor(accountB.id), { exact: true }).waitFor()
    createGate.release.resolve()
    await page.waitForTimeout(250)

    assert.equal(new URL(page.url()).pathname, '/ftml-projects')
    assert.equal(await page.getByText(titleFor(accountA.id), { exact: true }).count(), 0)
    assert.equal(await page.getByText(titleFor(accountB.id), { exact: true }).count(), 1)
    await assertNoPageErrors(harness)
  } finally {
    await harness.context.close()
  }
}

async function testInflightListCannotOverwriteNewAccount(browser) {
  const harness = await createHarness(browser)
  const { page } = harness
  try {
    const listGate = harness.holdNextList(accountA.id)
    await page.goto(`${baseUrl}/ftml-projects`, { waitUntil: 'domcontentloaded' })
    await waitForSignal(listGate.started, 'held A list request')

    await harness.switchAccount(accountB)
    await page.getByText(titleFor(accountB.id), { exact: true }).waitFor()
    listGate.release.resolve()
    await page.waitForTimeout(250)

    assert.equal(await page.getByText(titleFor(accountA.id), { exact: true }).count(), 0)
    assert.equal(await page.getByText(titleFor(accountB.id), { exact: true }).count(), 1)
    assert.ok(
      harness.ftmlRequests.some(request => request.method === 'GET' && request.expected === accountA.id)
    )
    assert.ok(
      harness.ftmlRequests.some(request => request.method === 'GET' && request.expected === accountB.id)
    )
    await assertNoPageErrors(harness)
  } finally {
    await harness.context.close()
  }
}

async function testSettledSourceAndStaleSave(browser) {
  const harness = await createHarness(browser)
  const { page } = harness
  try {
    await page.goto(`${baseUrl}/ftml-projects/${projectId}`, { waitUntil: 'domcontentloaded' })
    await waitForEditorSource(page, sources[accountA.id])

    // 完整源码已落地时，身份验证开始即清空 A；B 确认后再装载 B 的完整源码。
    const authGate = await harness.switchAccount(accountB, { holdAuth: true })
    await waitForSignal(authGate.started, 'held editor B auth request')
    await page.waitForFunction(secret => !document.body.innerText.includes(secret), 'A_SECRET_END_MARKER')
    await page.waitForFunction(oldTitle => !document.title.includes(oldTitle), titleFor(accountA.id))
    assert.equal(await page.title(), 'FTML 项目 - SCPPER-CN')
    authGate.release.resolve()
    await waitForEditorSource(page, sources[accountB.id])
    assert.equal(await page.title(), `${titleFor(accountB.id)} - FTML - SCPPER-CN`)

    // A 的旧 PATCH 即使成功，也不得在 B 的编辑器中显示“已保存”。
    await harness.switchAccount(accountA)
    await waitForEditorSource(page, sources[accountA.id])
    const saveGate = harness.holdNextSave(accountA.id)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await waitForSignal(saveGate.started, 'held A save request')

    await harness.switchAccount(accountB)
    await waitForEditorSource(page, sources[accountB.id])
    saveGate.release.resolve()
    await page.waitForTimeout(250)

    await waitForEditorSource(page, sources[accountB.id])
    assert.equal(await page.getByText('已保存', { exact: true }).count(), 0)
    assert.equal((await page.locator('body').innerText()).includes('A_SECRET_END_MARKER'), false)
    await assertNoPageErrors(harness)
  } finally {
    await harness.context.close()
  }
}

async function testInflightSourceCannotOverwriteNewAccount(browser) {
  const harness = await createHarness(browser)
  const { page } = harness
  try {
    const detailGate = harness.holdNextDetail(accountA.id)
    await page.goto(`${baseUrl}/ftml-projects/${projectId}`, { waitUntil: 'domcontentloaded' })
    await waitForSignal(detailGate.started, 'held A detail request')

    await harness.switchAccount(accountB)
    await waitForEditorSource(page, sources[accountB.id])
    detailGate.release.resolve()
    await page.waitForTimeout(250)

    await waitForEditorSource(page, sources[accountB.id])
    assert.equal((await page.locator('body').innerText()).includes('A_SECRET_END_MARKER'), false)
    assert.ok(
      harness.ftmlRequests.some(request => request.method === 'GET' && request.expected === accountA.id)
    )
    assert.ok(
      harness.ftmlRequests.some(request => request.method === 'GET' && request.expected === accountB.id)
    )
    await assertNoPageErrors(harness)
  } finally {
    await harness.context.close()
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  try {
    await testSettledListAndStaleCreate(browser)
    process.stdout.write('PASS settled FTML list clears on identity change and stale create cannot navigate\n')

    await testInflightListCannotOverwriteNewAccount(browser)
    process.stdout.write('PASS in-flight FTML list response cannot overwrite the new account\n')

    await testSettledSourceAndStaleSave(browser)
    process.stdout.write('PASS settled FTML source clears/reloads and stale save cannot report success\n')

    await testInflightSourceCannotOverwriteNewAccount(browser)
    process.stdout.write('PASS in-flight FTML source response cannot overwrite the new account\n')
  } finally {
    await browser.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
