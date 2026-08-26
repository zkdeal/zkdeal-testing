import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import { postJsonWithDeadline } from '../src/deadline-http-json.ts'

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address')
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

test('waits for delayed response headers until the configured deadline', async (context) => {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"decision":"proved"}')
    }, 100)
  })
  const baseUrl = await listen(server)
  context.after(() => close(server))

  const response = await postJsonWithDeadline(baseUrl, '/v5/cold-templates/prove', {}, 500)
  assert.equal(response.status, 200)
  assert.equal(response.body, '{"decision":"proved"}')
})

test('applies one explicit wall-clock deadline and reports a redacted timeout', async (context) => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end('{"decision":"too-late"}'), 250)
  })
  const baseUrl = await listen(server)
  context.after(() => close(server))

  await assert.rejects(
    postJsonWithDeadline(baseUrl, '/v5/cold-templates/prove', { secret: 'do-not-print' }, 30),
    (error: unknown) => {
      assert(error instanceof Error)
      assert.match(error.message, /PROVER_REQUEST_TIMEOUT/)
      assert.match(error.message, /\/v5\/cold-templates\/prove/)
      assert.doesNotMatch(error.message, /do-not-print|127\.0\.0\.1|http:/)
      return true
    },
  )
})

test('preserves an allowlisted connection cause without exposing the base URL', async () => {
  const server = createServer()
  const baseUrl = await listen(server)
  await close(server)

  await assert.rejects(
    postJsonWithDeadline(baseUrl, '/v5/cold-templates/prove', {}, 500),
    (error: unknown) => {
      assert(error instanceof Error)
      assert.match(error.message, /ECONNREFUSED/)
      assert.match(error.message, /\/v5\/cold-templates\/prove/)
      assert.doesNotMatch(error.message, /127\.0\.0\.1|http:/)
      return true
    },
  )
})
