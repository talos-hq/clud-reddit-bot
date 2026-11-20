/** Generic error detail for all responses. */
export type ErrorRsp = {error: string; status: number}

/** Liveness probe used by the "Show clud webhook" menu item. */
export type HealthRsp = {
  ok: boolean
  app: string
  subreddit: string
}

/** Body clud POSTs to the external ingest endpoint. */
export type IngestReq = {
  /** Post title. Falls back to the first line of `text`. */
  title?: string
  /** Markdown body of the run summary. */
  text?: string
  /** Optional link, for link posts. */
  url?: string
  /** Optional stable key so retries do not double-post. */
  idempotencyKey?: string
}

export type IngestRsp = {
  ok: true
  postId: string
  permalink: string
  /** True when the post already existed for this `idempotencyKey`. */
  duplicate?: boolean
}

/** Values submitted by the "Post clud run" moderator form. */
export type CludRunFormValues = {
  title: string
  url?: string
  body?: string
}

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint]
export const Endpoint = {
  Health: 'api/health',
  OnAppInstall: 'internal/on/app/install',
  OnMenuPostRun: 'internal/on/menu/post-clud-run',
  OnMenuWebhook: 'internal/on/menu/webhook',
  OnFormCludRun: 'internal/on/form/clud-run',
  OnFormWebhook: 'internal/on/form/webhook',
  ExternalIngest: 'external/ingest',
} as const

export const EndpointMethod = {
  [Endpoint.Health]: 'GET',
  [Endpoint.OnAppInstall]: 'POST',
  [Endpoint.OnMenuPostRun]: 'POST',
  [Endpoint.OnMenuWebhook]: 'POST',
  [Endpoint.OnFormCludRun]: 'POST',
  [Endpoint.OnFormWebhook]: 'POST',
  [Endpoint.ExternalIngest]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
