# Fabritorio

## Layer vocabulary

"L0", "L1", "L2" appear in comments, docs, and UI as conversational shorthand:

- L0 = composition contents (toolpack, skillpack, handler graph, cli_invocation graph)
- L1 = agent graph (`kind: "l1"` — Gateway / Handler / Output, plus Tools / Skills / Workspace)
- L2 = orchestration graph (`kind: "l2"` — Channel / Trigger / Agent, plus Memory)

The runtime does not branch on layer. These are graph kinds, not architectural layers — don't infer hierarchy from the naming. Per-kind constraints live in dynamic validation, not in the type system; the `L0Node` / `L1Node` / `L2Node` unions were removed precisely to stop suggesting a static contract that doesn't exist.
