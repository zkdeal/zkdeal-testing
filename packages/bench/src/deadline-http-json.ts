import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export interface DeadlineHttpResponse {
  status: number
  body: string
}

const SAFE_TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_SOCKET_CLOSED',
  'PROVER_REQUEST_TIMEOUT',
  'PROVER_RESPONSE_ABORTED',
])

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function transportCode(error: unknown): string {
  let current: unknown = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object') break
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && SAFE_TRANSPORT_CODES.has(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return 'NETWORK_ERROR'
}

function transportExplanation(code: string): string {
  switch (code) {
    case 'PROVER_REQUEST_TIMEOUT':
      return 'the configured request deadline expired before the response completed'
    case 'PROVER_RESPONSE_ABORTED':
      return 'the prover closed the response before it completed'
    case 'ECONNREFUSED':
      return 'the prover refused the connection'
    case 'ECONNRESET':
    case 'EPIPE':
    case 'ERR_SOCKET_CLOSED':
      return 'the prover connection closed unexpectedly'
    case 'ENOTFOUND':
      return 'the prover service name could not be resolved'
    case 'EAI_AGAIN':
      return 'the prover service name lookup was temporarily unavailable'
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'the prover network was unreachable'
    default:
      return 'the prover request failed at the network boundary'
  }
}

/**
 * POST one JSON request without Node global fetch's independent 300-second
 * first-header timeout. The only clock is the explicit wall-clock deadline,
 * which covers connection, response headers and response body together.
 *
 * Failure text intentionally names only the fixed API route, elapsed time and
 * an allowlisted transport code. It never repeats the configured base URL,
 * credentials, request bytes or an upstream error message.
 */
export async function postJsonWithDeadline(
  baseUrl: string,
  endpoint: string,
  body: unknown,
  timeoutMs: number,
): Promise<DeadlineHttpResponse> {
  if (!endpoint.startsWith('/')) throw new Error('the prover endpoint must be an absolute path')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('the prover request deadline must be a positive number of milliseconds')
  }

  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${endpoint}`)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('the prover URL must use http or https')
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  const started = performance.now()

  return await new Promise<DeadlineHttpResponse>((resolve, reject) => {
    let settled = false
    let deadline: ReturnType<typeof setTimeout> | undefined

    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      if (deadline) clearTimeout(deadline)
      action()
    }
    const fail = (error: unknown): void => {
      finish(() => {
        const code = transportCode(error)
        const elapsedMs = Math.max(0, Math.round(performance.now() - started))
        reject(
          new Error(
            `the CUDA prover transport failed for ${endpoint} after ${elapsedMs} ms (${code}): ${transportExplanation(code)}`,
            { cause: error },
          ),
        )
      })
    }

    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.byteLength),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('aborted', () => {
          fail(codedError('PROVER_RESPONSE_ABORTED', 'response aborted'))
        })
        response.on('error', fail)
        response.on('end', () => {
          finish(() => {
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            })
          })
        })
      },
    )

    request.on('error', fail)
    deadline = setTimeout(() => {
      request.destroy(
        codedError(
          'PROVER_REQUEST_TIMEOUT',
          `request exceeded its ${Math.round(timeoutMs)} ms deadline`,
        ),
      )
    }, timeoutMs)
    deadline.unref()
    request.end(payload)
  })
}
