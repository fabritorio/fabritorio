# Event & message architecture — communication boundary map

A hand-maintained map of how **messages** and **events** flow inside the runner
and out to the web client — the communication boundary made legible, so we can
design against it without re-deriving it from code each time.

Structured with **AsyncAPI** vocabulary: _server_ (transport), _channel_ (topic),
_message_ (payload), _operation_ (publish/subscribe), _producer/consumer_.

> **Maintenance:** hand-maintained, not CI-enforced — update when the event
> surface changes (rare).

---

## Two payload families — messages vs events

Fabritorio deliberately separates _what is communicated_ from _what is observed_.
They're structurally distinguishable: a message has a numeric `timestamp` and no
`type`; an event has a `type` discriminator (`isDispatchEvent`, `event-bus.ts`).

| Family            | Type                                                   | Shape                                                                   | Role                                                          |
| ----------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Message**       | `DispatchEvent` (`messages.ts`)                        | `{ eventId, parentId?, source, timestamp, messages: Message[], meta? }` | Transport — the actual content routed between graph entities  |
| **Event**         | `ObservabilityEvent` (`events.ts`, a union)            | typed, `type`-discriminated                                             | Telemetry — facts about what happened                         |
| **Visual event**  | `EdgeTraversedEvent` (`events.ts`, _not_ in the union) | `{ fromNodeId, toNodeId, edgeId, direction, … }`                        | Pure animation signal                                         |
| **Derived state** | `NodeRuntimeState` (`events.ts`)                       | `{ nodeId, dispatchEventId, phase, activeAsks, … }`                     | A _projection_ folded from the streams; not itself on the bus |

`ObservabilityEvent` subtypes: `llm.request` / `llm.chunk` / `llm.response`,
`tool.called` / `tool.result`, `gateway.received`, `output.emitted`,
`workspace.file`, `chain.stopped`, `dispatch.stopped`,
`model_router.attempted` / `model_router.fell_through`.

---

## Servers (transports)

1. **In-process `EventBus`** (`runtime/event-bus.ts`) — Node `EventEmitter`. Three
   broadcast channels (`dispatch`, `observability`, `traversal`) + a per-edge
   **topic pub/sub** (`publish`/`subscribeTopic`) + an in-memory recording
   (`byDispatch`, `rootsBySource`) used for history/replay.
2. **SSE firehose** — one always-on connection `GET /stream` (`routes/stream.ts`)
   emitting `{ topic, payload }` frames, demuxed client-side by the `StreamHub`
   singleton (`apps/web/lib/stream-hub.ts`). Forward-only.
3. **On-demand SSE** — opened only while a specific view is active (not part of
   the always-on budget): webchat, debug, debug-probe.
4. **History (not SSE)** — `GET /observability/replay` for backfill.

> ⚠️ **Two meanings of "topic"** — keep them distinct:
>
> - **Bus routing topic** — `publish(topicFor(edge))`, per-edge, internal _message
>   delivery_.
> - **SSE demux topic** — `observability` / `animation` / `status:<gid>` /
>   `permission:*`, the client-facing fan-out keys on `/stream`.

> 🫀 **No server heartbeat (known debt).** Every SSE route writes one `:\n\n`
> comment at open, then only real frames — no periodic keepalive. On direct
> localhost this is fine; behind an idle-timing proxy the connection can drop,
> after which `EventSource` reconnects and the server re-seeds every topic. (So
> multiple finished `/stream` rows in DevTools under "Preserve log" are reconnect
> history, not concurrent connections — `StreamHub` holds at most one.) Revisit
> if reconnect churn appears in a proxied deployment: add a periodic `:\n\n`.

---

## Internal bus channels — producer → consumer

| Channel                 | Carries                    | Producers                                                                                        | Consumers                                                                                                   |
| ----------------------- | -------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `dispatch`              | `DispatchEvent` (messages) | gateway / channel / trigger / agent-ask bindings **+ tool outbound** (`emitDispatch`)            | graph-runtime (ask-state); bus recording; `/stream` (muxed into `observability` topic as `kind:'dispatch'`) |
| `observability`         | `ObservabilityEvent`       | graph-handler (`llm.*`, `tool.*`); bindings (`gateway.received`, `output.emitted`); model router | graph-runtime (node-state derivation); bus recording; `/stream` (`observability` topic)                     |
| `traversal`             | `EdgeTraversedEvent`       | traversal binding (`bindings/traversal.ts`)                                                      | `/stream` (`animation` topic)                                                                               |
| per-edge routing topics | `DispatchEvent`            | bindings (`publish(topicFor(edge))`)                                                             | next node's binding (`subscribeTopic`); graph-runtime                                                       |

---

## SSE firehose `/stream` — demux topics → FE consumers

| SSE topic                       | Payload                                                 | FE consumer / use                                                                                     |
| ------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `observability`                 | `{ seq, kind: 'dispatch' \| 'observability', payload }` | `EventTree` / `LogViewer` drill-down; **asks + per-dispatch are client-side filters over this topic** |
| `animation`                     | `EdgeTraversedEvent`                                    | `FlowEdge` edge animation                                                                             |
| `status:<graphId>`              | `{ running: NodeRuntimeStateWire[] }`                   | node decorations: `phase`, asks                                                                       |
| `permission:<graphId>:<nodeId>` | permission requests                                     | permission prompts                                                                                    |

History/backfill: `GET /observability/replay`.

---

## On-demand SSE (separate connections, opened per view)

| Route                                       | Payload         | FE use                   |
| ------------------------------------------- | --------------- | ------------------------ |
| `/channels/webchat/:channelNodeId/stream`   | `DispatchEvent` | chat / conversation view |
| `/debug/:graphId/:nodeId/stream`            | `DispatchEvent` | debug gateway            |
| `/debug-probe/:graphId/:probeNodeId/stream` | events          | debug probe panel        |

All SSE routes (firehose + on-demand) share the `writeSseHead` head writer in
`runtime/sse.ts`.
