---
name: tool-builder
description: How to wrap an external integration as a single-binary CLI and register it as a runtime tool any Fabritorio agent can wire as a `tool` node. Default to Go; produce a static binary, write a `manifest.json` declaring the tool spec + adapter config, smoke-test, and optionally ship a sibling SKILL.md for behavioural guidance (when/why, not how-to-call).
---

# tool-builder — turn an integration into a callable runtime tool

You're a coder agent reading this because someone handed you a request shaped like _"build a CLI for X"_ — Linear, Notion, a REST API, an internal tool, anything Fabritorio's built-in catalog doesn't cover. The request may come from a human you're chatting with or from a calling agent. Your output is a static binary on disk **plus** a `manifest.json` that registers it as a first-class **runtime tool** — selectable from any agent's `tool` node, gated by permissions, called natively without going through `bash`.

**Clarify when the spec is underspecified; build when it's sufficient.** If the request leaves out something you genuinely can't default, ask for the missing pieces in your reply — to whoever sent the request — before building. If it's clear, build it and report. (See "What to clarify" below for the exact batch.)

**The manifest is the product.** A binary with no manifest is unreachable — the runtime tool registry won't surface it, downstream agents won't find it in the catalog, and the `tool` node won't resolve. Budget real attention on section 4; the Go code is the easy part. See `docs/runtime-tools.md` in the Fabritorio repo for the registry mechanics and lifecycle if you want the full picture.

## Path discipline — read this before doing anything else

**Your workspace root is `~/.fabritorio/` (real path: `/Users/<user>/.fabritorio/`).** Every file path in this skill is **relative to that root**. Don't use `~/...` in `write_file` / `edit_file` — those tools don't expand tildes and you'll create a literal `~` directory inside the workspace. Don't use absolute paths starting with `/Users/...` — the workspace gate will reject anything outside the root anyway.

When you need an absolute path for the manifest, the `bash` tool, or to report back to your caller, prefix the workspace-relative path with `/Users/<user>/.fabritorio/`. The `bash` tool expands `~` correctly (it goes through a real shell), but `write_file` and `edit_file` do not — be consistent and use relative everywhere in tool args; only use absolutes in the _contents_ of files you write (manifest paths, SKILL.md examples).

## TL;DR

- Source in `tools/<name>/` relative to workspace (`go.mod`, `main.go`, helpers). Absolute: `~/.fabritorio/tools/<name>/`.
- Binary at `tools/<name>/bin/<name>` — one static file, `chmod +x`.
- Manifest at `tools/<name>/manifest.json` — declares the tool name, description, JSON-Schema parameters, adapter (`bash_cli`), and flag mapping. **This is what makes the binary callable as a tool.**
- Optional SKILL.md at `skills/<name>/SKILL.md` (also workspace-relative) — only for behavioural guidance (when/why to use it, multi-step recipes). Skip it unless there's genuine _how to think about this tool_ content. The manifest already tells the model what the tool does and what args to pass.
- **Go is the default.** One static binary, no runtime deps, no venv. Python only when an SDK forces it.
- Credentials read from process env; the manifest declares which vars in its `description`.
- Smoke test (`bin/<name> --help`) before reporting back.
- If source / binary / manifest is missing, the task isn't done.

## 1. The deliverable

When you report back, three artifacts must exist on disk (paths shown relative to the workspace root `~/.fabritorio/`):

1. **Source tree** — `tools/<name>/` containing `go.mod`, `main.go`, any helpers. Source must build cleanly with `go build ./...` from that directory. No CGo, no platform shims unless the integration genuinely needs them.
2. **Binary** — `tools/<name>/bin/<name>`. One file. Static. **Executable bit set** (`chmod +x` — the registry skips non-executable binaries). `file bin/<name>` should report a Mach-O / ELF executable; `ls -la` should show ~10MB of statically-linked Go.
3. **Manifest** — `tools/<name>/manifest.json` with the shape in section 4. The `name` field must match the directory name and the binary name.

A fourth, **optional** artifact: `skills/<name>/SKILL.md` with behavioural guidance. Only ship it if there's content the manifest can't carry — multi-step workflows, "when to reach for this vs that", domain context. For a one-verb CLI, the manifest is enough; the skill would just restate the manifest.

If any required artifact is missing, the task isn't done. Report partial state explicitly ("source builds, smoke test fails on auth — needs LINEAR_API_KEY in env") rather than claiming success. Whoever sent the request will trust what you say literally.

## 1a. What to clarify

**If the spec is underspecified, don't guess — ask for the missing pieces in your reply, to whoever sent the request** (a human you're chatting with, or the calling agent). A guessed return shape or invented env var produces a confidently-wrong manifest that miswires downstream; a one-line question is cheaper than the rebuild.

**Gate on complexity.** Trivial single-verb obvious-return ("scrape this URL, give me the text") → just build. Multi-verb, ambiguous return, or unclear auth → clarify first. Ask in **one batch**, not one question at a time:

1. **Verbs.** What distinct operations? Each becomes its own tool — `issue_list`, `issue_create`, not one `linear` with subcommands.
2. **Return shape.** Per verb, what fields back, and as what — JSON array, single object, or plain text?
3. **Auth — pin the env var name by default.** If the integration authenticates at all (almost all do), the credential reaches your binary through a wired **Secrets node**, not the ambient environment — see section 5. The env var name is the contract between your manifest and the Secrets binding the user wires, so **always confirm the exact name before building** rather than inventing one: _"I'll read the token from `LINEAR_API_KEY` — you'll wire that into a Secrets node. Is that the name you want?"_ Propose the conventional name (`<UPPERCASE_TOOL>_API_KEY` / `_TOKEN`) and let the user correct it; renaming it later means re-editing the manifest **and** the user's Secrets binding. If it's OAuth-only with no personal-token path, say so — you can't run an OAuth dance (section 5).

This is the one auth question you ask even when the rest of the spec is trivial enough to just build: a no-auth scrape needs no clarification, but the moment a credential is involved, pin its env var name first.

Reserve clarification for facts you genuinely can't default — not for things this skill already settles (language, binary layout, manifest mechanics).

## 2. Language choice — Go default, escape hatch Python

**Default: Go.** Reasons that matter for the substrate, not aesthetics:

- _One static binary._ No `pip install`, no venv, no `node_modules`. A skill becomes a self-contained directory: copy it, run it, done. This matches Fabritorio's by-value composite philosophy — every artifact on disk is itself, not a manifest pointing at dependencies someone else has to resolve.
- _Fast cold start._ Agents will invoke the CLI dozens of times per session. Go subprocess startup is ~5ms; Python with imports is often 100ms+. Compounds fast over a long loop.
- _Excellent stdlib for the 80% case._ `net/http` + `encoding/json` covers most REST integrations with zero external dependencies. Most of what you write is a thin wrapper around `http.Client`.
- _Uniformity._ Single language across the CLI fleet means downstream agents can recognize patterns across them, and you (or a future tool-builder run) can copy from one to bootstrap another.

**Use Python only when** the integration ships a Python-only SDK that would take significantly longer to reimplement than to wrap (HuggingFace, certain ML APIs, some enterprise SDKs). When you do: isolate it in `~/.fabritorio/clis/<name>/.venv/`, write a shim script at `bin/<name>` that activates the venv and execs the entrypoint, document the deps in `requirements.txt` next to it, and pin versions. The SKILL.md must declare that the binary is a Python shim, not a static Go binary — downstream agents shouldn't have to discover that by accident.

**Never use Node.** Same dep-management problems as Python with no offsetting advantages.

**Never use shell scripts for anything non-trivial.** Quoting bugs, no JSON parsing without `jq` gymnastics, hard to test, hard to extend. A 60-line Go program is more maintainable than a 25-line bash incantation.

## 3. Build sequence

Workspace root is `~/.fabritorio/` — every path below is relative to it. Pass these as the `bash` tool's `command` arg with no `cwd` (workspace root is the default), or set `cwd: "tools/<name>"` after step 1 to keep commands tight.

```bash
# 1. Init module (first time only). bash expands the tilde correctly,
#    but staying inside the workspace via the relative tools/<name> form
#    keeps things consistent with write_file / edit_file calls.
mkdir -p tools/<name>/bin
cd tools/<name>
go mod init fabritorio/tool/<name>

# 2. Write main.go and any helpers via write_file with paths like
#    "tools/<name>/main.go" — workspace-relative, no leading ~ or /.

# 3. Build into bin/.
go build -o bin/<name> ./...
chmod +x bin/<name>

# 4. Smoke test — at minimum --help, ideally a dry-run that exercises
#    config-loading without making a network call.
./bin/<name> --help

# 5. Write manifest.json (see section 4 for the shape).
#    write_file path: "tools/<name>/manifest.json".
```

If `go build` fails, fix it before moving on. Do not ship a broken binary with a TODO in the manifest — downstream agents won't read your TODO, they'll just discover the breakage at the worst time.

The smoke test exists to catch the case where `go build` succeeds but the binary panics on first invocation (missing init, nil-deref in a global, broken flag parsing). `--help` is the cheapest exerciser.

**For integrations with auth:** when the credential is missing, exit cleanly with a one-line stderr message naming the env var. The runtime tool registry returns combined stdout+stderr as the tool result; `linear: LINEAR_API_KEY not set` is actionable, `panic: runtime error: invalid memory address` is not. Section 4's exit-code convention codifies this.

**`chmod +x` is load-bearing.** The registry scan checks the executable bit (`mode & 0o111`) and skips any binary that isn't executable. A tool that doesn't appear in the catalog after a rebuild is almost always a permissions issue first; check `ls -la bin/<name>` before assuming anything else is wrong.

## 4. The manifest.json — your actual product

This is where most tool-builder runs will underinvest. **Spend real attention here.** The runtime tool registry reads `manifest.json` at scan time and projects it into the model's tool catalog. The model sees `name`, `description`, and `parameters` (JSON Schema) — exactly what you write here. Bad description → model picks the wrong tool. Vague parameters → model passes garbage args. Wrong `arg_mapping` → binary gets called with bad flags. The Go code is mechanical; the manifest is where judgment matters.

The manifest lives at `~/.fabritorio/tools/<name>/manifest.json` (in the tool's own directory — the registry scans `~/.fabritorio/tools/*/manifest.json`). Reference: `docs/runtime-tools.md` in the Fabritorio repo for the full shape and registry mechanics.

### Required shape

```json
{
    "name": "<name>",
    "description": "<one line, ~15-25 words, concrete>",
    "parameters": {
        "type": "object",
        "properties": { ... },
        "required": [...],
        "additionalProperties": false
    },
    "adapter": "bash_cli",
    "adapter_config": {
        "binary": "bin/<name>",
        "arg_style": "flags",
        "arg_mapping": { "<param>": "--<flag>", ... },
        "timeout_ms": 60000
    }
}
```

- **`name`** — the runtime tool identifier. Must match `^[a-z][a-z0-9_]*$` (lowercase, underscores, no hyphens). This is what a downstream agent's `tool` node sets as `tool_name`. Must match the directory name and the binary name.
- **`description`** — the single most important field. The model sees this in the tool catalog and decides whether to reach for this tool over others. Make it concrete: _"Query Linear issues by assignee/status/cycle. Returns a JSON array of {id, title, state, url}."_ — not _"Helps with Linear stuff."_ Mention the return shape and any side effects (reads vs writes, idempotency).
- **`parameters`** — JSON Schema describing the arguments the model passes. Be tight: declare every arg in `properties`, list required ones in `required`, set `additionalProperties: false`. Each property's `description` is also model-visible — tell the model what good input looks like (formats, units, example values).
- **`adapter`** — `"bash_cli"` for v0. Other adapters (`http`, `mcp`) exist on paper but aren't shipping.
- **`adapter_config.binary`** — relative to the tool dir (recommended) or absolute. The registry resolves `bin/<name>` against `tool.dir`.
- **`adapter_config.arg_style`** — `"flags"`: render each arg as `--flag value` pairs. Boolean args become bare flags (`--verbose` when true, omitted when false).
- **`adapter_config.arg_mapping`** — maps each `parameters.properties` key to its CLI flag. Every arg the model can pass needs an entry; missing entries silently drop the arg.
- **`adapter_config.timeout_ms`** — defaults to 30 000 if omitted, capped at 300 000. Pick something realistic — 60 000 for a typical network-bound CLI, higher for long-running operations.

### Required-arg validation

The adapter walks `parameters.required` before invoking the binary; missing args return `{exit_code: 1, stderr: "missing required argument: <name>"}` without spawning the process. Type validation is primitive-level (string/number/boolean). You don't need to defend against this in `main.go`, but every required arg in your manifest must be one your binary actually needs — over-declaring required args makes the tool harder for the model to use.

### Worked example — `linear_query`

```json
{
    "name": "linear_query",
    "description": "Query Linear issues by assignee, status, or cycle. Returns a JSON array of {id, title, status, assignee, url, created_at}. Read-only; safe to call freely. Requires LINEAR_API_KEY in env.",
    "parameters": {
        "type": "object",
        "properties": {
            "assignee": {
                "type": "string",
                "description": "Filter by assignee username. Use 'me' for the API key owner. Omit to skip filter."
            },
            "status": {
                "type": "string",
                "description": "Filter by state name: 'Todo', 'In Progress', 'In Review', 'Done', 'Cancelled'. Omit to include all."
            },
            "limit": {
                "type": "number",
                "description": "Max results, default 20, max 100."
            }
        },
        "required": [],
        "additionalProperties": false
    },
    "adapter": "bash_cli",
    "adapter_config": {
        "binary": "bin/linear_query",
        "arg_style": "flags",
        "arg_mapping": {
            "assignee": "--assignee",
            "status": "--status",
            "limit": "--limit"
        },
        "timeout_ms": 60000
    }
}
```

One CLI, one manifest, one tool name. If your integration has multiple distinct verbs (`issue_list`, `issue_create`, `cycle_current`), produce one binary + one manifest per verb — each becomes its own runtime tool that the model wires individually. This is **better** than a multi-verb single CLI with subcommands: the model can wire just the verbs the agent needs, permissions gate per-verb, and the catalog reads more cleanly.

### Optional — the behavioural SKILL.md

Skip the SKILL.md unless there's genuine _how to think about this tool_ content. Examples of when a SKILL.md is worth shipping:

- Multi-tool workflows: _"Use `linear_query` first to find issue ids, then `linear_update` to mutate them — don't try to update by title."_
- Domain context the description can't carry: _"Linear cycles run Monday-Sunday; 'current cycle' means the one containing today's date."_
- Pitfalls: _"Rate limit is 1500/hr per key, shared across all tools that read LINEAR_API_KEY."_

When you do write one, it lives at `~/.fabritorio/skills/<name>/SKILL.md` (the SkillRegistry's scan root, separate from `~/.fabritorio/tools/`). The frontmatter is the same shape Fabritorio skills always use:

```yaml
---
name: <name>
description: <one line>
---
```

The body is behavioural guidance only — _don't_ document invocations, flags, or return shapes here. The manifest is canonical for those; SKILL.md saying otherwise just drifts. If your tool is one verb and stands alone, the manifest is enough and a SKILL.md is noise.

## 5. Credentials — the Secrets node is the path

**A built tool gets its credentials from a wired Secrets node, not from the ambient environment.** This is the default and only supported mechanism; design every authenticated tool around it.

The chain, end to end:

1. The user keeps real values in `~/.fabritorio/secrets.env` (a `KEY=value` file). The runner loads them into a private in-memory store — **deliberately not `process.env`**, so a spawned binary inherits no credentials by default.
2. The user drops a **Secrets node** and adds a binding: a `name` (the env var your binary reads) with `source: "env:NAME"` (the key in `secrets.env`).
3. The user wires `secrets → tool` (or `secrets → tool_pack`) on the canvas. **The wire is the grant** — least-privilege by construction. No wire ⇒ the binary sees zero credentials.
4. At call time the `bash_cli` adapter injects exactly that named subset onto the binary's spawn env. Your CLI reads it the ordinary way: `os.Getenv("FOO_API_KEY")`.

So the env var name your binary reads (step 4) must be the same name the user wires as the Secrets binding (step 2). **That name is the contract** — it's the name you pinned in the interview (section 1a) and the name you put in the manifest `description` ("Requires `LINEAR_API_KEY` in env"). Get it agreed up front; a later rename touches the manifest _and_ the user's Secrets binding.

Note this differs from the built-in `bash` tool, which just inherits `process.env` and carries **no** secrets — runtime tools (the `bash_cli` binaries you build) are the only path that receives injected credentials. Don't tell the user to `export FOO_API_KEY=...` in a shell or stuff it into `process.env`; route them to a Secrets node every time.

Rules:

- **Never** write credentials to source files, hard-code an API key in `main.go`, or embed one in SKILL.md examples. Examples use placeholders or omit the value entirely.
- **Always** read each credential from a single named env var via `os.Getenv`, and name it `<UPPERCASE_TOOL>_API_KEY` or `<UPPERCASE_TOOL>_TOKEN`. State that name in the manifest `description` so the wiring agent knows which Secrets binding to add; restate it in your report-back (section 7).
- On missing credential, exit `2` with `<cliname>: FOO_API_KEY not set` on stderr. Predictable failure beats opaque crash — and it's the exact signal the user needs to go wire (or fix the name on) the Secrets node.
- **Don't** read from a config file in `~/.config/<tool>/` or wherever the upstream tool's convention is. Single-source via the injected env var keeps tool-builder outputs uniform and keeps the Secrets node the one credential surface.

For credentials that need user interaction (OAuth flows with no long-lived-token path): out of scope for now. If the integration only supports OAuth and offers no personal-API-key fallback, surface that to your caller and do not attempt to implement an OAuth dance — it requires a browser callback and persistent state that this skill doesn't yet cover.

## 6. Updating an existing tool

If you're called to extend or fix a tool that already exists in `tools/<name>/` (workspace-relative; absolute `~/.fabritorio/tools/<name>/`), do not rewrite from scratch. `list_directory` the tool dir, `read_file` `main.go` and the existing `manifest.json`, and make targeted edits.

Then: rebuild, re-`chmod +x`, re-run the smoke test, and **update the manifest** if you changed any flag, the parameter schema, the binary path, or the timeout. **Stale manifest content is worse than missing content** — the model trusts the projected `parameters` schema and will pass args your binary no longer accepts, producing silent miswiring rather than a clean error.

If you change the tool's `name` (manifest, binary, directory must all change together), every graph with a `tool` node referencing the old name breaks at handler-build time. Don't rename casually. If you must rename, leave a placeholder dir + manifest with the old name that exits `1` with `"renamed to <new_name>"` on stderr — gives the user a clean signal in the agent's tool result instead of a confusing "unknown tool" error.

Hot reload: the registry rescans on every `GET /tools` and on every `tool.get(name)` miss inside an agent build. A rebuild + `chmod +x` is visible on the next Dispatch without restarting the runner.

## 7. What to report back

When your caller is Foreman (or another orchestrator), the reply should be factual and short:

- Tool name (the `name:` field in the manifest — what the downstream `tool` node will wire).
- Binary path (absolute).
- Manifest path (absolute).
- SKILL.md path (absolute), if you shipped one — and one line on why.
- The credential env var name(s) the tool reads, if any — name them explicitly so the user knows which Secrets binding to add (value in `~/.fabritorio/secrets.env`, `name` on a Secrets node wired to this tool). See section 5.
- Smoke test result — what `--help` printed (one-line summary), or first error if the test failed.

Don't editorialize, don't recap the design choices, don't restate the brief. Your caller integrates this into a user-facing reply; the user wants to know it works and what they need to do (set an env var, mostly). Skip everything else.

If the build failed: report the failure plainly, what you tried, and what's blocking. Do not retry indefinitely — three attempts is plenty; after that, surface the blocker. Your caller can decide whether to redirect or to hand control back to the user.
