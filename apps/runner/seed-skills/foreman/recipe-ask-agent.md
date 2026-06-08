<!-- Foreman resource. Loaded on demand via `Skill({name:"foreman", resource:"recipe-ask-agent"})`.
     Not part of the always-loaded core playbook; pull it when you are about to wire one agent to call another, dispatch via ask_agent, or load prior turns. -->

## 6. Recipe — call a sub-agent with `ask_agent`

`ask_agent` is your synchronous delegation primitive. **Treat it like a
tool call where the tool is another agent**: you pass a brief, the
runtime ships it to the callee on the bus, the callee runs its full
gateway → handler → output loop, and the reply comes back as the tool
result for your current model turn. No new turn fabricated on your
side, no fan-out gymnastics — one trace, one root, one reply.

This replaces the older "build a sub-agent, dispatch onto its channel,
hope a reply shows up later" pattern. If you want to delegate work
mid-turn and integrate the result, use `ask_agent`.

### Three preconditions

Before `ask_agent` will succeed, all three must hold:

1. **Target agent loaded.** The callee's L1 must be persisted and its
   L2-level node (e.g. a `native_agent`) must exist on a loaded L2.
   Usually you just instantiated it via `create_graph` /
   `instantiate_composite` and added it to the canvas via `edit_graph` —
   that activates it.
2. **Outgoing edge from caller to target's input.** Your agent's node
   must have an event-flow edge whose target is the callee's agent
   node (port `input` on the L2 side, or directly to the agent node id).
   The edge **is** the call capability. No edge → no call. See the
   "Wire two agents" subsection below.
3. **Validator wiring is sane.** Trigger→Agent is unidirectional (no
   replying to a trigger). Agent-to-agent edges have no fan-out limit,
   so you can wire one Foreman to many sub-agents freely. Channel↔Agent
   1:1 is recommended convention but not enforced.

### Tool args

```json
{
    "target_agent_id": "<CALLEE_AGENT_NODE_ID>",
    "brief": "Add a top-level README.md describing the project layout.",
    "inherit_session": false,
    "timeout_ms": 60000
}
```

- `target_agent_id` — the **node** id of the callee's agent node on
  the L2 (e.g. the `native_agent` id), not the callee's L1 graph id.
- `brief` — the user-shaped message the callee will see in its
  Gateway. Write it the way you'd write a tool prompt: self-contained,
  unambiguous, no "as we discussed" references the callee can't follow.
- `inherit_session` — defaults to `false`. See below.
- `timeout_ms` — defaults to 60000. Override only when the callee is
  known to be slow (long ReAct loop, network-bound CLI).

### `inherit_session: true` vs default

- **Default (`false`) — fresh ephemeral source.** The callee gets a
  brand-new `dispatch.source`, so its Memory thread is isolated from
  yours. This is the right shape for **stateless task farmers**:
  callee does one thing, returns the result, doesn't accumulate state
  across calls. Use this for "go fetch the schema", "go run the
  benchmark", "format this draft" — anywhere you'd be uncomfortable
  with the callee remembering prior conversations.
- **`true` — share the caller's session.** The callee participates in
  the user's full session: its `prior_turns` will see the user's
  earlier turns, and Memory keyed on source persists across the
  caller's session boundary. Use this when the sub-agent is **part of
  the same conversation** — e.g. a specialist that needs to read the
  user's earlier framing to do its job, or a peer in a
  generator/evaluator loop where both should see the running thread.

When in doubt, default. Sharing the session leaks context that's
usually noise to the callee.

### Worked example — Foreman calls a freshly-built coder

You've just instantiated a coder agent (`coder-1` on the canvas L2,
referencing `<CODER_L1_ID>`), wired the inbound channel for the user,
and want Foreman to hand it the user's first task synchronously.

```json
// 1. Wire Foreman → Coder so Foreman has the call capability.
//    edit_graph args, on the canvas L2 id.
{
    "id": "<CANVAS_L2_ID>",
    "graph": {
        "kind": "l2",
        "nodes": [
            /* ... existing channel, foreman-agent, coder-1, etc. ... */
        ],
        "edges": [
            ,
            /* ... existing user channel ↔ foreman edges ... */ {
                "id": "e-foreman-to-coder",
                "source": { "node_id": "foreman-agent", "port_id": "output" },
                "target": { "node_id": "coder-1", "port_id": "input" }
            }
        ]
    }
}
```

```json
// 2. Now Foreman can call the coder. ask_agent args:
{
    "target_agent_id": "coder-1",
    "brief": "Add a top-level README.md describing the project layout. Read the package.json and the src/ tree first.",
    "inherit_session": false
}
// → tool result is the coder's final Output content. Integrate it into
//   your reply to the user (e.g. "Coder finished — README added.").
```

### Failure modes

- **`no outgoing edge from <caller> to <target>`** — the call wiring is
  missing. **Fix the wiring**, don't retry. Add the edge with
  `edit_graph` (above), then re-call.
- **`ask_agent timed out after Nms`** — the callee never produced an
  Output before the deadline. Either the callee is genuinely stuck
  (look at the canvas / event log), or `timeout_ms` is too tight for
  this sub-agent's loop. Don't blindly retry; diagnose first.
- **`ask_agent requires an in-flight Dispatch context`** — you tried
  to call `ask_agent` from outside an agent loop (e.g. via DebugGateway
  with no parent Dispatch). Not your problem to fix mid-build; surface
  it to the user.

If the call fails, **fix the topology rather than retrying.** A failed
`ask_agent` is almost always a missing edge, a wrong node id, or a
callee that hasn't loaded yet. Retrying without changing anything just
burns another timeout.

## 6a. Recipe — wire two agents (call capability)

Agent-to-agent calls are gated by event-flow edges. To grant agent A
the ability to call agent B via `ask_agent`, add an edge from A's
output port to B's input port on the L2 graph.

### One-way (orchestrator → worker)

Foreman calls coder; coder cannot call Foreman back.

```json
// edit_graph args (single edge added to existing canvas L2)
{
    "id": "<CANVAS_L2_ID>",
    "graph": {
        "kind": "l2",
        "nodes": [
            /* unchanged */
        ],
        "edges": [
            ,
            /* ... existing edges ... */ {
                "id": "e-foreman-to-coder",
                "source": { "node_id": "foreman-agent", "port_id": "output" },
                "target": { "node_id": "coder-1", "port_id": "input" }
            }
        ]
    }
}
```

### Two-way (peer-to-peer, e.g. generator + evaluator)

Both agents need to call each other — a generator drafts, an evaluator
judges, the generator iterates. Wire **both** edges explicitly:

```json
{
    "edges": [
        ,
        /* ... */ {
            "id": "e-gen-to-eval",
            "source": { "node_id": "generator", "port_id": "output" },
            "target": { "node_id": "evaluator", "port_id": "input" }
        },
        {
            "id": "e-eval-to-gen",
            "source": { "node_id": "evaluator", "port_id": "output" },
            "target": { "node_id": "generator", "port_id": "input" }
        }
    ]
}
```

The loop lives in the calling agent's handler logic (each side calls
`ask_agent` on the other and decides when to stop), not in the graph.

### Validator notes

- **Channel↔Agent 1:1 is convention, not enforced.** Recommended:
  one channel bidirectionally wired to one agent. Multi-channel and
  multi-agent shapes still pass the validator; prefer 1:1 anyway so the
  session id (`source = channel:<id>`) stays unambiguous.
- **Agent-to-agent fan-out is unrestricted.** Foreman can have call
  edges to ten sub-agents simultaneously; no validator complaint.
- **Triggers are unidirectional.** A trigger node fires roots into an
  agent; no `ask_agent` reply path back to a trigger. Don't try.

## 6b. Recipe — load prior turns

`prior_turns` returns the recent root-Dispatch turns of the **current
session** (the in-flight Dispatch's `source`). Use it at the start of
a turn when the agent needs to reconstruct what was discussed earlier
in the same session — multi-turn chat continuity, mid-task recall,
"what was the user trying to do three messages ago".

### Tool args

```json
{
    "limit": 10
}
```

- `limit` — max number of _turns_ (user+assistant pairs) to return,
  most recent N. Default 10. A turn whose reply hasn't emitted yet
  contributes only its user entry.
- The in-flight turn is **excluded** — `prior_turns` returns history
  up to but not including the message you're currently processing,
  so you don't see your own current question echoed back.

### Return shape

JSON array of `{eventId, timestamp, role, content}` entries, oldest
first:

```json
[
    { "eventId": "...", "timestamp": "...", "role": "user", "content": "Build me a coder" },
    {
        "eventId": "...",
        "timestamp": "...",
        "role": "assistant",
        "content": "Done. Coder wired to ~/Projects/foo."
    },
    { "eventId": "...", "timestamp": "...", "role": "user", "content": "Now have it add a README" }
]
```

Feed the array back into the model context (typically as prior
messages, or summarized into the next prompt) to recover context.
Don't re-display it to the user — it's input for your own reasoning,
not output.
