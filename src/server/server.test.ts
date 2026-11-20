import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import type {AddressInfo, Server} from 'node:net'
import {after, before, beforeEach, test} from 'node:test'
import {type Context, reddit, redis, runWithContext} from '@devvit/web/server'
import type {UiResponse} from '@devvit/web/shared'
import {
  Endpoint,
  type ErrorRsp,
  type HealthRsp,
  type IngestRsp,
} from '../shared/api.ts'
import {onReq} from './server.ts'

let server: Server
let serverURL: string

const claimedKeys = new Set<string>()
const redisSet = redis.set.bind(redis)
const submitPost = reddit.submitPost.bind(reddit)
const submitted: {title: string; text?: string; url?: string}[] = []

before(async () => {
  redis.set = async (key, _value, options) => {
    if (options?.nx && claimedKeys.has(key)) return ''
    claimedKeys.add(key)
    return 'OK'
  }
  reddit.submitPost = (async (opts: {
    title: string
    text?: string
    url?: string
  }) => {
    submitted.push({title: opts.title, text: opts.text, url: opts.url})
    return {
      id: 't3_abc123',
      permalink: '/r/clud/comments/abc123/run/',
      url: 'https://www.reddit.com/r/clud/comments/abc123/run/',
    }
  }) as unknown as typeof reddit.submitPost

  server = createServer(async (req, rsp) => {
    await runWithContext(
      {
        appName: 'clud-bot',
        appSlug: 'clud-bot',
        appVersion: '0.0.1',
        commentId: undefined,
        postData: undefined,
        postId: undefined,
        subredditId: 't5_clud',
        subredditName: 'clud',
        userId: 't2_123',
        username: 'ZachVorhies',
      } as unknown as Context,
      () => onReq(req, rsp),
    )
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const info = server.address() as AddressInfo
  serverURL = `http://127.0.0.1:${info.port}`
})

after(async () => {
  redis.set = redisSet
  reddit.submitPost = submitPost
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()))
  })
})

beforeEach(() => {
  claimedKeys.clear()
  submitted.length = 0
})

async function postJson(path: string, body: unknown): Promise<Response> {
  return await fetch(`${serverURL}/${path}`, {
    body: JSON.stringify(body),
    headers: {'Content-Type': 'application/json'},
    method: 'POST',
  })
}

test('health', async () => {
  const rsp = await fetch(`${serverURL}/${Endpoint.Health}`)
  assert.equal(rsp.status, 200)
  assert.deepEqual<HealthRsp>(await rsp.json(), {
    ok: true,
    app: 'clud-bot',
    subreddit: 'clud',
  })
})

test('menu opens the run form', async () => {
  const rsp = await postJson(Endpoint.OnMenuPostRun, {})
  assert.equal(rsp.status, 200)
  const ui = (await rsp.json()) as UiResponse
  assert.equal(ui.showForm?.name, 'cludRun')
  assert.equal(ui.showForm?.form.fields.length, 3)
})

test('form submit creates a text post', async () => {
  const rsp = await postJson(Endpoint.OnFormCludRun, {
    title: 'Fixed the flaky CI',
    body: 'clud ran 3 agents.',
    url: '',
  })
  assert.equal(rsp.status, 200)
  const ui = (await rsp.json()) as UiResponse
  assert.equal(ui.navigateTo, '/r/clud/comments/abc123/run/')
  assert.deepEqual(submitted, [
    {title: 'Fixed the flaky CI', text: 'clud ran 3 agents.', url: undefined},
  ])
})

test('form submit rejects an empty run', async () => {
  const rsp = await postJson(Endpoint.OnFormCludRun, {title: 'Only a title'})
  assert.equal(rsp.status, 200)
  const ui = (await rsp.json()) as UiResponse
  assert.equal(ui.navigateTo, undefined)
  assert.equal(submitted.length, 0)
})

test('external ingest creates a post', async () => {
  const rsp = await postJson(Endpoint.ExternalIngest, {
    idempotencyKey: 'run-1',
    text: '# Run 42\nAll agents green.',
    title: 'Run 42',
  })
  assert.equal(rsp.status, 200)
  const body = (await rsp.json()) as IngestRsp
  assert.equal(body.ok, true)
  assert.equal(body.postId, 't3_abc123')
  assert.equal(submitted.length, 1)
})

test('external ingest dedupes on idempotencyKey', async () => {
  const payload = {idempotencyKey: 'run-1', text: 'body', title: 'Run 1'}
  assert.equal((await postJson(Endpoint.ExternalIngest, payload)).status, 200)
  const dup = await postJson(Endpoint.ExternalIngest, payload)
  assert.equal(dup.status, 500)
  assert.match(((await dup.json()) as ErrorRsp).error, /already ingested/)
  assert.equal(submitted.length, 1)
})

test('wrong method', async () => {
  const rsp = await fetch(`${serverURL}/${Endpoint.OnMenuPostRun}`)
  assert.equal(rsp.status, 404)
})
