# Mojomaxi deployment notes

## Required environment
Use `.env.example` as the source of truth. At minimum, production should set:

- `NEXT_PUBLIC_SITE_URL`
- `NEXT_PUBLIC_VAULT_PROGRAM_ID`
- `SOLANA_RPC_URL` or `HELIUS_RPC_URL`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `X_MM_INTERNAL_TOKEN` or `MM_INTERNAL_TOKEN`
- `CRON_SECRET`
- `VERCEL_AUTOMATION_BYPASS_SECRET`
- `RELAYER_SECRET` or `ADMIN_RELAYER_SECRET`

## Launch checklist

1. Confirm all `/api/*` routes return an `X-Request-Id` header in production.
2. Verify Upstash rate limiting is configured and not falling back to degraded mode.
3. Verify `/api/rpc` only permits your intended JSON-RPC methods.
4. Keep `CLOSEBINS_ADMIN_SECRET` set and do not expose it to the client.
5. Confirm service worker update by checking `CACHE_VERSION` changes on deploy.
6. Smoke test `buy`, `sell`, webhook ingest, manual swap, rebalance, and vault deposit/withdraw paths.
7. Verify relayer balance and treasury ATA existence before launch.
8. Run `npm run typecheck` and `npm run build` on the exact production env.

## Recommended operational monitors

- Request volume and 429 rate per route
- `/api/rpc` upstream latency and non-200 responses
- Redis availability / degraded middleware logs
- Swap queue depth and retry/error rates
- Webhook ingest latency
- Relayer SOL balance floor alerts
