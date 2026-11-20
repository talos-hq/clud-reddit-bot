# clud-bot

Devvit app that publishes **clud** agent-run summaries to
[r/clud](https://www.reddit.com/r/clud) as `u/clud-bot`.

Registered on Reddit as app **clud-bot** — owner ZachVorhies:
<https://developers.reddit.com/apps/clud-bot>

## What it does

| Surface                              | Endpoint                         | Behaviour                                                                |
| ------------------------------------ | -------------------------------- | ------------------------------------------------------------------------ |
| App install                          | `internal/on/app/install`        | posts a welcome self-post to the subreddit                               |
| Subreddit menu → _Post clud run_     | `internal/on/menu/post-clud-run` | opens the `cludRun` form (title / link / run summary)                    |
| Form submit                          | `internal/on/form/clud-run`      | `reddit.submitPost()` as the app account, then navigates to the new post |
| Subreddit menu → _Show clud webhook_ | `internal/on/menu/webhook`       | shows the external ingest URL                                            |
| External ingest                      | `external/ingest`                | accepts `{title, text, url?, idempotencyKey?}` and posts it              |
| Health                               | `api/health`                     | `{ok, app, subreddit}`                                                   |

Ingest retries are deduped in Redis on `idempotencyKey` for 7 days.

## Status of the external webhook

The external endpoint is declared in `devvit.json`:

```json
"server": {
  "externalEndpoints": {
    "ingest": {"endpoint": "/external/ingest", "scopes": ["install", "global"]}
  }
}
```

Calling it currently returns:

```
7 PERMISSION_DENIED: external endpoints are not enabled for this app
```

That is a Reddit-side allowlist gate on the experimental external-endpoints
feature, not an app bug — the code path is covered by the unit tests. Once
Reddit enables external endpoints for the app, the menu item will print a
usable URL that a local clud runner can POST to.

## Commands

```bash
npm run test          # types + biome + unit tests + build
npm run build         # esbuild server bundle into dist/server
npx devvit upload --bump patch
npx devvit install r/clud clud-bot@<version>
npx devvit logs r/clud clud-bot --since 30m
```

`devvit login` stores the token in `~/.devvit/token`.

## Layout

```
src/shared/api.ts     endpoint names, methods, request/response types
src/server/index.ts   node http server entry
src/server/server.ts  routing + menu/form/ingest handlers
src/server/db.ts      redis idempotency helper
src/server/*.test.ts  node:test suite (mocks redis + reddit)
```

## Notes

- `permissions.redis` and `permissions.reddit` are enabled in `devvit.json`.
- The app posts as the app account (`u/clud-bot`), which is installed as a
  moderator on the subreddit.
- Unpublished apps can only be installed in subreddits under 200 subscribers;
  `npx devvit publish` submits the app for review when it should go wider.
