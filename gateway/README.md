# Model gateway

Each role has a stable loopback OpenAI-compatible address. Consumers send the
role as their model name; changing the role map changes the serving backend.

| Role | Address | Model |
| --- | --- | --- |
| main | `http://127.0.0.1:18010/v1` | `main` |
| coder | `http://127.0.0.1:18011/v1` | `coder` |
| fast | `http://127.0.0.1:18012/v1` | `fast` |

These are deployment ports. Development fixtures use 8894–8899. Unit tests use
fake listeners and fake upstreams, so they open no sockets.

## Deployment

Build standalone Node 22 entries with the existing esbuild dependency:

```sh
npx esbuild gateway/src/index.ts --bundle --platform=node --format=esm --outfile=dist/gateway/index.js
npx esbuild gateway/src/seed.ts --bundle --platform=node --format=esm --outfile=dist/gateway/seed.js
```

Install both entries and `role-map.default.json` in `/usr/lib/wayroost-gateway`,
owned by root and mode 0644, and the units from `deploy/` in the system unit
folder. The service uses `/usr/bin/node`. Start the socket unit and service.
The packaged map uses invented example backends. Before the first start, install
a local map at `/etc/wayroost-gateway/role-map.local.json` (root-owned, mode 0644, with
directories readable by the service user). The seed path takes precedence over
the packaged map and never replaces a map already in the state directory. An
invalid local seed fails startup.
Validate either map from the checkout with
`npx tsx scripts/validate-role-map.ts /home/me/role-map.json`.
The service has a dynamic user, private state and runtime directories, an
unlimited restart count and a one-second restart delay. PID 1 retains the three
role listeners across service crashes and restarts. `LISTEN_PID` and `LISTEN_FDS`
are validated; inherited descriptors must have the corresponding loopback
addresses. Explicit `--listen` flags cannot be combined with socket activation.

The map lives at `/var/lib/private/wayroost-gateway/role-map.json`, avoiding the
symlink at `/var/lib/wayroost-gateway`. A plain `ExecStartPre` seeds it once as the
service user, mode 0600. Existing maps are preserved. The admin socket is
`/run/wayroost-gateway/admin.sock`, mode 0600 inside a mode-0700 directory.

A credential drop-in supplies `LoadCredential=<provider>:<absolute-key-file>`.
The gateway reads `CREDENTIALS_DIRECTORY` automatically; credential names in the
map refer only to entries in that directory. The packaged example needs no
credentials. Supply each provider named by your local map through the drop-in.
A key change requires a drain and
restart so systemd supplies the new credential. A stopped or failed socket unit
is separate from an unhealthy backend: reset failures on both units, then
restart the socket unit. `/healthz` tests the gateway event loop, not a backend.

## Role map

Version 2 follows `shared/gateway.ts`. It contains `contracts`, a named
`backends` catalogue, profile/engine `profiles` rows and the current `roles` row.
Each role maps to a backend ID or `null`. Each backend declares its served name,
context window, capabilities, output cap, optional provider credential name and
price, and expected listener UID for a loopback backend. No inline keys or
arbitrary credential paths are accepted. HTTP backends must be loopback; remote
backends require HTTPS. URLs cannot carry user info, queries or fragments.

The packaged `example/vllm` profile uses invented served names and backend ports.
Each example role admits text and tools, has no thinking-level map, advertises a
32,768-token context and a 4,096-token catalog output cap. Set served names, listener
owners, capabilities and limits in the local map to match the engine configuration.
All profile rows and admin repoints must fit their role contracts. Requests exceeding a
contract's capabilities receive 400 before forwarding. Generation
limits (`max_tokens`, `max_completion_tokens`, `max_output_tokens`, `n_predict`)
must be positive integers. Each supplied field is preserved, with values above
the serving backend's `maxOutputTokens` lowered to that cap. When no limit is
supplied, the gateway forwards without one so the engine can size output to the
remaining context, as for a direct request. Image contract checks
inspect only `image_url` and `input_image` parts in input message content.

`thinkingLevels` controls the catalog's selectable thinking levels. Each backend
separately declares `acceptsReasoningEffort` (boolean, default `false`), meaning
its engine accepts top-level `reasoning_effort`, including `none`. The gateway
intersects this flag across all non-null backends assigned to a role in profile
rows and its current mapping, including a manual override. If all accept it,
the field is forwarded unchanged even with `thinkingLevels: false`. Otherwise,
the field is removed and counted as `reasoning_effort_dropped` in usage events,
usage summaries and private status. Malformed values receive 400 before either
forwarding or dropping; accepted string values are `none`, `minimal`, `low`,
`medium`, `high`, `xhigh` and `max`. Other thinking-level fields still follow
`thinkingLevels`. Omitting `reasoning_effort` adds no field or adjustment.

Acceptance is engine and template dependent: SGLang passes effort to its template
and defaults thinking switches from it; llama.cpp disables thinking for `none`
and may expose other values to its template. A proxy that passes the field on
inherits its upstream engine's acceptance. The example vLLM backends explicitly
use `false`: versions whose schema accepts only `low`, `medium` and `high` reject
`none`. Confirm the complete vocabulary against the installed engine before
setting a backend's flag to `true`.

The gateway pins config, admin and credential directory identities and uses
Linux `/proc/self/fd` handles for file operations. Symlinks and directories or
files writable by other accounts are refused. A failed reload keeps the last
good mapping. Admin writes are serialized, synced and renamed before activation.
A request retains its backend snapshot through a concurrent repoint.

For an isolated development run, provide a private config and admin directory,
set each fake backend's `listenerUid` to its actual UID, and use explicit ports:

```sh
node dist/gateway/index.js --config /home/me/gateway/role-map.json \
  --socket /home/me/gateway/admin.sock --listen main=8898
```

Startup limits are `--max-request-bytes` (64 MiB), `--backend-timeout-ms`
(900000), `--idle-timeout-ms` (600000) and `--health-timeout-ms` (3000).
The backend header deadline includes connecting and checking the owner.

## Consumer HTTP interface

Every answer carries `Connection: close`. The Host header must name this
listener's loopback address and port; browser Origin and Sec-Fetch-Site headers
are refused. Consumer authorization, cookies and arbitrary headers never reach
the backend. Redirects are returned without following them.

- `GET /healthz`: backend-independent 200 on every role listener, including unmapped roles.
- `GET /v1/models`: this role's alias, with `context_length` and `max_model_len`
  from its current backend. No backend probe is made.
- `GET /health`: a credentialed backend model probe, returning JSON 200/503.
- `POST /v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/responses`:
  JSON with the matching role alias. The role is rewritten to the served model;
  supplied output limits are clamped and unsupported `reasoning_effort` is
  removed with an adjustment count. Tool definitions, messages and other
  provider extensions remain unchanged. SSE flows with backpressure.

Unmapped inference resets as soon as its HTTP headers identify the route, before
reading its body. Health remains available on those listeners. A mapped backend
connection failure also resets the consumer without an HTTP answer.
Before sending any bytes to a loopback backend, the gateway matches the accepted
end of its connection in `/proc/net/tcp` or `tcp6` and checks its UID. A missing
or unexpected owner fails closed. It never retries inference.

HTTP answers, including 502–504, retain their status and body. Context overflows
on `/v1/chat/completions` and `/v1/completions` are the exception: the supported
llama.cpp, SGLang and vLLM errors become an OpenAI-shaped 400,
code `context_length_exceeded`, stating "This model's maximum context length is
N tokens", using the request's backend snapshot. Only complete error wording
matching the engine fixtures is recognized. Streams inspect the first data event,
skipping comments and empty lines; unrelated responses retain their bytes.
Other routes, including Responses, preserve backend overflow answers.
The engine fixtures follow
[llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-context.cpp),
[SGLang](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/managers/tokenizer_manager.py)
and [vLLM](https://github.com/vllm-project/vllm/blob/v0.10.2/vllm/entrypoints/openai/serving_engine.py).
Malformed JSON or a wrong alias receives 400, oversized bodies 413, and
unsupported content type/encoding 415. Broken streams close the connection.

## Private admin interface

Only the private Unix socket exposes admin operations:

- `GET /healthz`: event-loop health even when all roles are unmapped.
- `GET /v1/status`: each role's backend ID, model, contract, real context,
  backend health, loopback backend port, effective `acceptsReasoningEffort`,
  persistent named adjustment counts, in-flight requests and open consumer
  connections. Backend URLs and credential references are omitted. An unexpected
  backend owner appears as `owner_mismatch`.
- `POST /v1/credentials/<provider>/test`: one fixed, one-token request to the named
  backend with the supplied stored key. The probe has a five-second deadline and
  returns only provider/backend names or a fixed error code. It never persists
  the key or returns upstream text. This route is available on the admin socket only.
- `PUT /v1/roles/<role>`: exactly `{"backend":"backend-id"}` or
  `{"backend":null}`. Unknown IDs and incompatible capabilities receive 400.
- `PUT /v1/profiles/<profile>/<engine>`: atomically select a complete catalogue
  row, removing manual overrides from the current mapping. Unknown rows receive 400.
- `POST /v1/drain`: keep serving until no consumer connection is open, then
  close the accepting handles in the same event-loop step. The CLI exits cleanly
  after answering `{"status":"drained"}`, and systemd restarts it. Connections
  arriving in between wait on PID 1's backlog. A drain waits up to ten minutes,
  then answers `still_busy` and keeps serving. Concurrent drains receive 409.
  The caller retries every ten minutes and offers an explicit restart after two
  hours, identifying the streams it would cut.
- `POST /v1/usage/summary`: the `usage.summary` request and response from
  `shared/supervisor-config.ts`. Supply `windows`, each with an ID (`today` or
  `week`) and a millisecond `since` value. The supervisor relays this
  status-class operation; no content or raw events are returned.

Drain accounting runs from accept to close, so a partial upload or an idle
consumer keeps the service alive. Untagged consumers count equally. An ordinary
stop or crash can cut existing connections; the socket unit keeps listening.

## Usage and checks

One metadata-only usage event is recorded per inference attempt, with errors
for unmapped inference and backend connection failures. The tap never adds stream
options. It scans top-level usage in JSON and bounded SSE events, including
Responses completion usage, with a 64 KiB cap, then copies
named token/count/cost fields through `shared/usage.ts`. Missing usage remains
missing; failed requests, including JSON Responses failures and SSE errors under HTTP 200, do not contribute
success counts. Local usage costs zero, priced
backends use token prices, and provider-reported cost takes precedence. The
OpenTelemetry attribute mapping is local; nothing goes to a collector.

Private `usage.jsonl` retains raw metadata for 35 days, after which
`usage.daily.jsonl` keeps daily totals. Serialized daily maintenance also enforces
retention while idle. Startup discards an incomplete final raw record, preserving
complete records. Summaries group by role and backend/model.
Adjustment counts include failed requests and survive restart and daily
compaction. Private status totals cover all retained usage for each role.
CLI logs contain fixed route categories, status and timing, never content,
headers, URLs, credential paths or underlying exception messages.

```sh
npm run -s typecheck
npx vitest run gateway/test
npx vitest run
node gateway/test/parity-probe.mjs
```

The `gateway-systemd` CI job runs under sudo on a hosted Ubuntu runner. It
installs the units at deployed paths, checks user-owned seeding and persisted
repoints, repeatedly kills the service, verifies that all role ports remain
bound, exercises pooled requests and a partial upload across a drain within the
three-second metadata deadline, and checks that a foreign backend UID receives
no request bytes. The harness requires `CI=true` and root and is not a local
smoke test. `cli-smoke.ts` is an optional development-port check for environments
that allow sockets.

`parity-probe.mjs` builds the gateway entry and starts it with a recording stub
backend and temporary private state inside this clone. It checks ports before
binding and uses only loopback ports 28000–28999. Both forwarding and dropping
cases send a request with top-level `reasoning_effort` and no output limit,
compare the recorded request in full, and check status and usage adjustment
counts. All child processes, listeners and temporary files are removed on exit.
