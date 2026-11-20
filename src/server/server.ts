import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, externalEndpoints, reddit} from '@devvit/web/server'
import type {
  PartialJsonValue,
  TriggerResponse,
  UiResponse,
} from '@devvit/web/shared'
import {
  type CludRunFormValues,
  Endpoint,
  EndpointMethod,
  type ErrorRsp,
  type HealthRsp,
  type IngestReq,
  type IngestRsp,
} from '../shared/api.ts'
import {dbClaimIdempotencyKey} from './db.ts'

type AnyRsp = HealthRsp | IngestRsp | UiResponse | TriggerResponse | ErrorRsp

/** Maximum body accepted from an external ingest caller. */
const MAX_INGEST_BYTES = 32 * 1024

const WELCOME_TEXT = [
  'This subreddit is wired up to **clud**, the local harness that delegates',
  'autonomous coding runs to Claude Code and Codex.',
  '',
  'Moderators can publish a run summary with **Post clud run** in the',
  'subreddit menu. Automated ingest over a webhook is pending Reddit',
  'approval; until then posts go up through that menu.',
].join('\n')

export async function onReq(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  try {
    await route(reqMsg, rspMsg)
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`
    console.error(msg)
    writeJson<ErrorRsp>(500, {error: msg, status: 500}, rspMsg)
  }
}

async function route(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  const endpoint = reqMsg.url?.split('?')[0]?.slice(1) as Endpoint
  const method = EndpointMethod[endpoint]

  let rsp: AnyRsp
  if (method !== reqMsg.method) {
    rsp = {error: 'not found', status: 404}
  } else {
    switch (endpoint) {
      case Endpoint.Health:
        rsp = routeHealth()
        break
      case Endpoint.OnAppInstall:
        rsp = await routeAppInstall()
        break
      case Endpoint.OnMenuPostRun:
        rsp = routeMenuPostRun()
        break
      case Endpoint.OnMenuWebhook:
        rsp = await routeMenuWebhook()
        break
      case Endpoint.OnFormCludRun:
        rsp = await routeFormCludRun(reqMsg)
        break
      case Endpoint.OnFormWebhook:
        rsp = {
          showToast: {
            text: 'Close this form to finish.',
            appearance: 'neutral',
          },
        }
        break
      case Endpoint.ExternalIngest:
        rsp = await routeExternalIngest(reqMsg)
        break
      default:
        endpoint satisfies never
        rsp = {error: 'not found', status: 404}
        break
    }
  }

  writeJson<PartialJsonValue>('status' in rsp ? rsp.status : 200, rsp, rspMsg)
}

function routeHealth(): HealthRsp {
  return {ok: true, app: context.appSlug, subreddit: context.subredditName}
}

async function routeAppInstall(): Promise<TriggerResponse> {
  try {
    await reddit.submitPost({
      subredditName: context.subredditName,
      title: 'clud — bot is online',
      text: `${WELCOME_TEXT}\n\n---\n\n_installed by u/${context.username ?? 'a moderator'}_`,
      sendreplies: false,
    })
  } catch (err) {
    console.error(
      `install welcome post failed; ${err instanceof Error ? err.message : err}`,
    )
  }
  return {}
}

function routeMenuPostRun(): UiResponse {
  return {
    showForm: {
      name: 'cludRun',
      form: {
        title: 'Post a clud run',
        description: 'Published as the clud-bot app account.',
        acceptLabel: 'Post',
        fields: [
          {
            name: 'title',
            label: 'Title',
            type: 'string',
            required: true,
            helpText: 'Shown in the subreddit feed.',
          },
          {
            name: 'url',
            label: 'Link (optional)',
            type: 'string',
            helpText:
              'Fill this for a link post; leave blank to post the body as text.',
          },
          {
            name: 'body',
            label: 'Run summary',
            type: 'paragraph',
          },
        ],
      },
    },
  }
}

async function routeMenuWebhook(): Promise<UiResponse> {
  let webhook: string
  try {
    const root = await externalEndpoints.getExternalUrl({
      appSlug: context.appSlug,
      locationId: context.subredditId,
    })
    webhook = root.endsWith('/') ? `${root}ingest` : `${root}/ingest`
  } catch (err) {
    const msg = err instanceof Error ? err.message : `${err}`
    const text = /PERMISSION_DENIED|not enabled/i.test(msg)
      ? 'Inbound webhook is pending Reddit approval; use "Post clud run" for now.'
      : `No webhook yet: ${msg}`
    return {showToast: {text, appearance: 'neutral'}}
  }

  return {
    showForm: {
      name: 'webhook',
      form: {
        title: 'clud webhook',
        description:
          'POST JSON {title, text, url?, idempotencyKey?} to this URL to publish a run.',
        acceptLabel: 'Done',
        fields: [
          {
            name: 'url',
            label: 'Webhook URL',
            type: 'string',
            disabled: true,
            defaultValue: webhook,
            helpText: 'Copy this into your clud runner.',
          },
        ],
      },
    },
  }
}

async function routeFormCludRun(reqMsg: IncomingMessage): Promise<UiResponse> {
  const values = await readJson<CludRunFormValues>(reqMsg)
  const title = (values.title ?? '').trim()
  const body = (values.body ?? '').trim()
  const url = (values.url ?? '').trim()

  if (!title) {
    return {showToast: {text: 'A title is required.', appearance: 'neutral'}}
  }
  if (!body && !url) {
    return {
      showToast: {text: 'Add a run summary or a link.', appearance: 'neutral'},
    }
  }

  const post = await submitCludPost({
    title,
    text: body || undefined,
    url: url || undefined,
  })
  return {
    showToast: {
      text: `Posted to r/${context.subredditName}.`,
      appearance: 'success',
    },
    navigateTo: post.permalink,
  }
}

async function routeExternalIngest(
  reqMsg: IncomingMessage,
): Promise<IngestRsp> {
  const body = await readBody(reqMsg, MAX_INGEST_BYTES)
  if (!body) throw Error('empty request body')

  const req = JSON.parse(body) as IngestReq
  const text = (req.text ?? '').trim()
  const url = (req.url ?? '').trim()
  const title = (req.title ?? firstLine(text)).trim()

  if (!title) throw Error('title is required')
  if (!text && !url) throw Error('text or url is required')

  const key = (req.idempotencyKey ?? '').trim()
  if (key && !(await dbClaimIdempotencyKey(key))) {
    throw Error(`already ingested for idempotencyKey ${key}`)
  }

  const post = await submitCludPost({
    title,
    text: text || undefined,
    url: url || undefined,
  })
  return {ok: true, postId: post.id, permalink: post.permalink}
}

type CludPost = {title: string; text?: string; url?: string}

async function submitCludPost(opts: CludPost) {
  const {title, text, url} = opts
  if (url) {
    return await reddit.submitPost({
      subredditName: context.subredditName,
      title,
      url,
      sendreplies: false,
    })
  }
  return await reddit.submitPost({
    subredditName: context.subredditName,
    title,
    text: text ?? '',
    sendreplies: false,
  })
}

function firstLine(text: string): string {
  const line = text.split('\n').find(l => l.trim().length > 0) ?? ''
  return line.replace(/^#+\s*/, '').slice(0, 300)
}

async function readJson<T>(reqMsg: IncomingMessage): Promise<T> {
  const body = await readBody(reqMsg, MAX_INGEST_BYTES)
  return JSON.parse(body) as T
}

async function readBody(
  reqMsg: IncomingMessage,
  limit: number,
): Promise<string> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of reqMsg) {
    const buf = chunk as Uint8Array
    size += buf.length
    if (size > limit) throw Error(`request body exceeds ${limit} bytes`)
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeJson<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json)
  const len = Buffer.byteLength(body)
  rsp.writeHead(status, {
    'Content-Length': len,
    'Content-Type': 'application/json',
  })
  rsp.end(body)
}
