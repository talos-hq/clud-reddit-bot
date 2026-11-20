import {redis} from '@devvit/web/server'

/** How long an ingest idempotency key is remembered. */
const IDEMPOTENCY_TTL_MS = 1000 * 60 * 60 * 24 * 7

/**
 * Claims an idempotency key so a retried ingest does not double-post.
 *
 * @returns true when the key was claimed here for the first time.
 */
export async function dbClaimIdempotencyKey(key: string): Promise<boolean> {
  const rsp = await redis.set(idempotencyKey(key), '1', {
    nx: true,
    expiration: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
  })
  return rsp === 'OK'
}

function idempotencyKey(key: string): string {
  return `clud:idempotency:${key}`
}
