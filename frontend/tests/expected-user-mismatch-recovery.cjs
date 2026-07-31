const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const baseUrl = process.env.ACCOUNT_TEST_BASE_URL || 'http://127.0.0.1:19876'
const iso = '2026-07-30T08:00:00.000Z'
const transparentPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64'
)

function user(id, displayName) {
  return {
    id,
    email: `${id}@example.com`,
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

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body)
  })
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  // Reproduce privacy modes where auth broadcasts cannot use localStorage.
  await context.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Storage disabled for test', 'SecurityError')
      }
    })
  })

  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error))

  const accountA = user('account-a', '账号 A')
  const accountB = user('account-b', '账号 B')
  let cookieAccount = accountA
  let authReads = 0
  const collectionExpectedUsers = []
  const ftmlRequests = []
  const ftmlProject = {
    id: 'project-a',
    title: '账号 A 的 FTML 项目',
    pageTitle: null,
    pageTags: [],
    isArchived: false,
    createdAt: iso,
    updatedAt: iso
  }

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
    if (apiPath === '/auth/me') {
      authReads += 1
      return fulfillJson(route, { ok: true, user: cookieAccount })
    }
    if (apiPath === '/collections') {
      const expected = request.headers()['x-scpper-expected-user-id'] || null
      collectionExpectedUsers.push(expected)
      if (expected && expected !== cookieAccount.id) {
        return fulfillJson(route, {
          ok: false,
          code: 'account_mismatch',
          error: '登录账号已切换，请刷新后重试。'
        }, 409)
      }
      return fulfillJson(route, { ok: true, total: 0, items: [] })
    }
    if (apiPath.startsWith('/ftml-projects')) {
      const expected = request.headers()['x-scpper-expected-user-id'] || null
      ftmlRequests.push({ method: request.method(), path: apiPath, expected })
      if (expected && expected !== cookieAccount.id) {
        return fulfillJson(route, {
          ok: false,
          code: 'account_mismatch',
          error: '登录账号已切换，请刷新后重试。'
        }, 409)
      }
      if (apiPath === '/ftml-projects' && request.method() === 'GET') {
        return fulfillJson(route, { projects: [ftmlProject] })
      }
      if (apiPath === `/ftml-projects/${ftmlProject.id}` && request.method() === 'DELETE') {
        return fulfillJson(route, { ok: true })
      }
    }
    return fulfillJson(route, { ok: false, error: `Unexpected API request: ${apiPath}` }, 404)
  })

  try {
    await page.goto(`${baseUrl}/collections`, { waitUntil: 'domcontentloaded' })
    await page.getByText('账号 A', { exact: true }).waitFor()
    await page.getByText('目前还没有收藏夹。可以先创建一个，或在页面右上角点击星标快速收藏。', { exact: true }).waitFor()
    assert.equal(collectionExpectedUsers.at(-1), 'account-a')

    // FTML projects must use the same guarded BFF transport for both private
    // reads and writes. A native fetch here would omit the expected-user
    // header and old-server compatibility would silently accept the request.
    await page.goto(`${baseUrl}/ftml-projects`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'FTML 项目', exact: true }).waitFor()
    await page.getByText(ftmlProject.title, { exact: true }).waitFor()
    assert.deepEqual(
      ftmlRequests.find(entry => entry.method === 'GET'),
      { method: 'GET', path: '/ftml-projects', expected: 'account-a' }
    )

    await page.getByRole('button', { name: '删除', exact: true }).click()
    await page.getByRole('heading', { name: '确认删除', exact: true }).waitFor()
    await Promise.all([
      page.waitForResponse(response => (
        new URL(response.url()).pathname === `/api/ftml-projects/${ftmlProject.id}`
        && response.request().method() === 'DELETE'
      )),
      page.locator('.modal-content').getByRole('button', { name: '删除', exact: true }).click()
    ])
    assert.deepEqual(
      ftmlRequests.find(entry => entry.method === 'DELETE'),
      {
        method: 'DELETE',
        path: `/ftml-projects/${ftmlProject.id}`,
        expected: 'account-a'
      }
    )

    await page.goto(`${baseUrl}/collections`, { waitUntil: 'domcontentloaded' })
    await page.getByText('目前还没有收藏夹。可以先创建一个，或在页面右上角点击星标快速收藏。', { exact: true }).waitFor()

    // Another tab has replaced the HttpOnly cookie with B, but its storage
    // broadcast is unavailable. The next private read still carries snapshot A.
    cookieAccount = accountB
    const authReadsBeforeMismatch = authReads
    const collectionReadsBeforeMismatch = collectionExpectedUsers.length
    await page.getByRole('button', { name: '刷新', exact: true }).click()

    await page.getByText('账号 B', { exact: true }).waitFor()
    await page.getByRole('button', { name: '刷新', exact: true }).waitFor({ state: 'visible' })
    assert.ok(authReads > authReadsBeforeMismatch, '409 must trigger a fresh /auth/me read')
    assert.equal(
      collectionExpectedUsers[collectionReadsBeforeMismatch],
      'account-a',
      'the first read after the cookie changes must carry trusted snapshot A'
    )

    // AccountAuthGate remounts account-owned content after B is resolved. Its
    // next collection read must use B and ordinary interaction must resume.
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByRole('button', { name: '刷新', exact: true }).waitFor()
    assert.equal(collectionExpectedUsers.at(-1), 'account-b')
    assert.equal(pageErrors.length, 0, pageErrors.map(error => error.stack).join('\n'))

    process.stdout.write('PASS account mismatch revalidates session and restores interaction\n')
  } finally {
    await context.close()
    await browser.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
