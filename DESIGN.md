# Splash — Architecture & Design (v2)

Status: **Steps 1-2 implemented; rest design-only.**

Purpose: let a frontier orchestrator (Claude Code, OpenAI Codex) delegate
*implementation* work to a **local LLM worker** to **significantly reduce
frontier token consumption**, while the frontier model stays the
**authoritative reviewer**. Two goals, equally weighted:

1. **Token efficiency** — generated code is produced and consumed *locally*;
   the frontier only sees compact metadata, and pulls the actual diff on demand.
2. **Safety** — the local model has zero repository control; all filesystem
   and git operations are owned by Splash, confined to an isolated workspace.
   Ownership boundary: **Splash owns the isolated workspace; the orchestrator
   (primarily Claude Code) owns changes to the real repository.** In v1
   Splash has no apply operation — it never modifies the main repo.

**Client priority.** Primary orchestrator/client: **Claude Code** — Splash is
designed and optimized for it first. Secondary compatibility target:
**OpenAI Codex** — preserved through *standard MCP behavior* only. The v1
architecture and ergonomics must not become more complex solely to
accommodate Codex: **no Codex-specific additions** unless they are also
useful for Claude Code or required for MCP compatibility.

```
Claude Code / Codex   (orchestrator + reviewer)
   │  splash_task(task, files)
   ▼
Splash MCP ── reads (read-only) ──► main repo working tree        [context + rules]
   │  sends budgeted, redacted context package
   ▼
Local coding model  (worker — no fs, no shell, no git)
   │  returns structured patch + short summary
   ▼
Splash MCP ── validates patch ── applies ──► isolated task workspace (git worktree)
   │  returns COMPACT result (ids, summary, file list, stats, warnings — no code)
   ▼
Claude Code / Codex
   │  accepts → splash_close(session)
   │     base_status fresh → git apply <patch_path>
   │     base_status stale  → no auto-apply; patch stays on disk; orchestrator decides
   │  needs to inspect → splash_diff (the only tool returning code text)
   └── rejects → splash_refine(session, feedback) → same loop
```

**The token story.** Per round, the frontier ingests: the task it already
wrote + a compact result (a few hundred tokens) + optionally a diff it
*chose* to pull (usually far smaller than full source). The expensive part —
generating complete code — happens on the local model, and the generated
source is never proxied into the frontier unless the orchestrator explicitly
requests the diff. Accepting a result costs the frontier one command when the
close reports a **fresh** base: `git apply` of the patch that `splash_close`
exports — not a re-emission of the code. (A stale close exports the patch but
never auto-applies it — the orchestrator decides; Section 7.5.) On the
*local* side, the adaptive context budget (Section 5) exact-measures each
round and selects the smallest tier that fits — no manual configuration.

---

## 1. Minimum components

Seven components. Deliberately few; each is small.

| # | Component | One-line responsibility |
|---|-----------|------------------------|
| 1 | **MCP Server** (tool layer) | Transport (v1: stdio; core decoupled) + exposes 4 tools; owns config; hosts the global Inference Coordinator. |
| 2 | **Session Manager** | Creates/tracks/closes worker sessions; holds history; enforces the adaptive context budget + `max_rounds` guardrail. |
| 3 | **Context Assembler** | Reads the main repo (read-only), loads rules, packs the context package with the adaptive budget (exact tokenization, tiers, `needs_split`), redacts secrets. |
| 4 | **Workspace Manager** *(new)* | Owns the isolated task workspace: create, base-capture, patch validation, apply, reset, diff/stat, export, destroy. The only component that writes files or runs git. |
| 5 | **Inference Backend** | Pluggable adapter over a local model engine; one stable interface. v1: **OpenAI-compatible HTTP only** (final). |
| 6 | **Worker Contract** | Builds the constrained worker prompt (policy) and normalizes worker output into a structured patch. |
| 7 | **Inference Coordinator** | Process-wide **single-flight FIFO** queue over the inference backend; host runtime conflict check; lock/state under `~/.splash/runtime/`. |

## 2. Responsibilities of each component

**1. MCP Server**
- Owns the MCP transport. **v1 is stdio only**; the server core (tool
  dispatch + session) is transport-agnostic so another transport is a leaf
  adapter added later, not a rewrite.
- **Client priority:** primary = Claude Code (tool ergonomics optimized for
  it); secondary = OpenAI Codex via standard MCP — no Codex-specific
  additions unless they also help Claude Code or are required for MCP
  compatibility.
- Registers the tools (Section 3) and maps JSON args to internal calls.
- Loads and validates **config** (backend, `repo_root` override, rules
  discovery, budgets, redaction patterns, output root — default `~/.splash`,
  Section 7.6).
- **Hosts the Inference Coordinator** (Section 2.7) — the single
  process-wide instance all sessions share; the MCP Server owns its
  lifecycle (startup readiness, lock handling, shutdown cleanup).
- **Project root (final):** the MCP process **CWD** is the discovery starting
  point; the discovered Git toplevel is the default project root for all
  sessions (Section 2), overridable via `repo_root` in config. Normal Claude
  Code usage **never passes a repo root per call**.
- No business logic beyond dispatch. Thin.

**2. Session Manager**
- Assigns an opaque `session_id` per delegated work item.
- Holds per-session state: worker message history, pinned rules, task,
  the **editable base file set + fingerprints** (Section 7.5), optional
  additional read-only context files, round counter, and the running
  **context budget** counter.
- **Enforces the adaptive context budget** (Section 5) at session level:
  *always retained* — resolved rules (8,192-token soft budget), the current
  task, the required editable base files (**complete, never truncated**), the
  latest orchestrator feedback, the latest validation verdict; *reduction
  order when the exact-measured request does not fit* — (1) evict old
  refinement history, (2) remove obsolete previous worker responses, then the
  Context Assembler reduces read-only reference context. Editable source code
  always outranks conversation history.
- **Max rounds guardrail (final):** configurable, default `max_rounds = 10` —
  to detect pathological correction loops, not to interrupt legitimate work.
  At the limit the session is **not destroyed**: the round returns a compact
  `status: "max_rounds"` warning and the persistent session (Section 2
  persistence) is preserved, so the orchestrator can continue explicitly,
  inspect, close, or start a new task.
- **Immutable base** (Section 7.5): the base file set and fingerprints
  (existence + type + mode + content) are captured once at creation and never
  change; the Session Manager runs the **stale-base check** (incl.
  created-path collision) before `splash_refine` and `splash_close`.
- **Project root (final):** resolved once per session — an explicit
  `repo_root` config if present, otherwise **auto-discovered**: start from
  the MCP process CWD and walk upward until the Git toplevel is found
  (Git-native, equivalent to `git rev-parse --show-toplevel`; the query
  itself is a read-only Workspace Manager operation). The discovered root
  becomes the session's default project root. If no valid Git repository is
  found (and no override is configured), `splash_task` fails with a **clear
  configuration/project error** — nothing is created.
- Lifecycle: create (persist to disk) → (many refine rounds, each persisted)
  → close (stale-base check reported — **a stale base never blocks the
  close**; on a successful close: export + destroy + on-disk session state
  removed, the exported patch remains, Section 7.6; if the **export itself
  fails** with an operational error, the workspace and session state are
  **preserved** so the session stays recoverable, Section 7.5). Restore by
  `session_id` is possible after any process restart.
- **Persistence (final): disk is the source of truth.** Every session is
  persisted under `~/.splash/sessions/<session-id>/` (same user-level root as
  patches; config-overridable): task, project/repo identity, resolved rules +
  `rules_source`, the editable base file set, base fingerprints (existence +
  type + mode + content), **the worker-created path set** (for scoped reset
  cleanup), the immutable base/worktree identity (repo root + base commit),
  additional read-only context, the round history required for refinement,
  the latest patch/result, and usage + budget state. Active sessions are **loaded into RAM** while in
  use; a Splash process **restart never loses an open session** — any
  existing session is **recoverable by `session_id`**. **Recovery rule:** if
  the persisted worktree **still exists and matches the persisted session
  identity, it is reused** (no unnecessary destroy/recreate of a valid
  surviving worktree); **otherwise it is recreated** from the persisted
  immutable-base information (and the latest validated full patch set
  re-applied). Enough immutable-base recovery information is persisted under
  the session directory that recovery never depends on volatile in-memory
  state, and **all stale-base checks still apply** before `splash_refine` /
  `splash_close` exactly as in a live session (the main tree may have
  drifted while the process was down).
- **Concurrency model (final):** multiple sessions may exist and remain
  open **concurrently** — session state, workspace operations, persistence,
  and `splash_diff` inspection coexist freely across sessions. The one
  exception is **inference**: a session's inference request goes to the
  global **Inference Coordinator** (single-flight FIFO, Section 2.7) — a
  same-process wait is an ordinary FIFO queue wait (the call returns the
  normal result), while a detected **external** runtime conflict returns
  `inference_busy` immediately (Section 3). In neither case is the session
  ever destroyed.

**3. Context Assembler**
- **Reads** the **main repo working tree** (read-only) — the *current* state,
  including the orchestrator's uncommitted changes (the truth the user sees).
  Two-tier supply (Section 7.5): **editable base files** are served from the
  *immutable base*, never from the live tree; **additional read-only files**
  are read fresh from the live tree at call time.
- Input: the file paths the orchestrator chose (Section 5) + the **resolved
  rules** (Section 6: a session-supplied payload, or — as fallback —
  `CLAUDE.md` / `AGENTS.md` read from the repo root; this read is the
  read-only half of rule resolution).
- **Adaptive context budget (final, Section 5)** — replaces any fixed
  per-file/per-task cap:
  - **Editable base files: complete, never truncated** — no fixed per-file
    token limit (Zeus has legitimate source files of hundreds of KB); they
    are sent whole whenever the runtime window fits them.
  - **Exact token measurement** — the candidate prompt is tokenized with the
    local server's **tokenizer endpoint** (Inference Backend) *before every
    inference request*; no character/line/byte heuristics.
  - **Output headroom** — reserve minimum **32,768** tokens, preferred
    **65,536** when capacity permits (both configurable); the input is never
    allowed to consume the whole window.
  - **Adaptive tiers** — select the smallest tier that safely fits
    (64K / 128K / 192K / runtime maximum — scheduling targets, not hard
    limits); never exceed `maximum_context_tokens`; a task that fits in 64K
    is not inflated to 128K/192K; large Zeus tasks move up automatically.
  - **Reduction priority** (when the candidate does not fit): (1) evict old
    refinement history, (2) drop obsolete previous worker responses,
    (3) reduce/truncate additional **read-only** reference context,
    (4) trim non-essential ancillary context.
  - **Rules soft budget** — default 8,192 tokens; over budget → compact
    redundant rule material deterministically where safe + record a warning;
    never silently drop safety-critical or task-critical rules.
  - **`needs_split`** — if required editable context + the minimum output
    reserve cannot fit, assemble **nothing** and truncate **nothing**: report
    `status: "needs_split"` with compact metadata (Section 3) so Claude Code
    splits the task automatically.
  - **Explicit override** — config / task `options` may override budget
    behavior for debugging or exceptional cases; normal usage needs none.
  - **Redacts** secrets before anything leaves the process (Section 9).
- Emits a single, deterministically-ordered context block for the worker
  (additional read-only files are labeled as *read-only reference*).
- Performs the read-only half of the **stale-base check** (Section 7.5):
  records the live-tree existence/type/mode + content of the base files — and
  of any worker-created paths — for the Session Manager to compare against
  the captured fingerprints.
- Never writes, executes, or runs git.

**4. Workspace Manager** *(the new core of the design)*
- Creates the **isolated task workspace** (Section 7) at session start.
- **Base-captures** the workspace state (HEAD + the repo's **exact working-
  tree delta — staged and unstaged**, `git diff HEAD --binary --full-index` —
  + the **selected untracked** context files, including git-ignored files the
  secret/safety policy allows) so that "the base" == exactly what the Context
  Assembler handed to the worker; the transient base commit is made with
  **hooks disabled, signing off, a deterministic Splash identity** (Section
  7.3), and **records a fingerprint of every editable base file — existence +
  type + relevant mode + content** (Section 7.5). The base is then
  **immutable**: patch validation stays deterministic, the exported patch
  stays mergeable, and the stale-base check has something to compare against.
- **Validates** every worker patch *before* applying (Section 7.4):
  allow-list, path bounds, **unique search-match against the immutable base,
  overlap detection/rejection**. **Rejected edits never modify the
  workspace.**
- Applies validated patches and **marks worker-created files with
  intent-to-add (`git add -N`)** so they appear in `splash_diff`, diff stats,
  and the exported patch while remaining uncommitted worker results; on each
  refine round: **reset tracked state to the same immutable base, remove the
  previous round's worker-created paths (scoped to the known set — never a
  broad `git clean`), then apply the new full patch set** (patches are always
  expressed against that base — no incremental drift, and **no re-sync/rebase
  from the main repo ever happens**).
- Produces **diff / stat** output (native `git diff`) for `splash_diff` and
  for compact responses — worker-created files included via intent-to-add;
  the final export is the **complete `--binary --full-index` patch**
  (Section 7.6).
- On close: **exports** the final patch as
  `<outputRoot>/patches/<repo-id>/<session-id>.patch` (default
  `outputRoot = ~/.splash` — **outside the project repository**; required
  directories are **created automatically**; the file **remains on disk**
  after the workspace is destroyed; the **absolute** `patch_path` is
  returned in the close result; Section 7.6), then **destroys** the
  workspace (removes the worktree).
- The only component that writes files or invokes git — and only inside the
  workspace, the output directory, or read-only queries against the main repo
  (including repo-root discovery via `git rev-parse --show-toplevel`).

**5. Inference Backend** (adapter)
- Stable interface: `run(messages, options) -> { content, usage }`.
- **v1 has exactly one implementation: `OpenAICompatBackend`** — the
  OpenAI-compatible HTTP API (`/v1/chat/completions`) against a locally
  served model. **`OllamaBackend` is deliberately NOT in v1.** The
  interface is what's permanent: Ollama or other engines can be added
  later as leaf adapters without touching the core.
  - **Configurable:** `base_url` and `model` come from config. Defaults:
    `base_url = http://127.0.0.1:8000`, `model = incoai/Qwen3.8-27B-Splash`.
    In v1 `base_url` is a **server-origin URL**: non-root path prefixes,
    query strings, fragments, and embedded credentials (`user:pass@`) are
    rejected at config load.
  - **Optional API key (final):** `api_key` from the `SPLASH_API_KEY`
    environment variable (trimmed; blank = unset). When set it is sent as
    `Authorization: Bearer <key>`; it is never logged and never part of any
    error message.
- **Runtime capacity (authoritative, final):** at startup / backend
  readiness, query the runtime's status endpoint for
  `maximum_context_tokens` (it depends on the current model, hardware, and
  memory budget) — **never hard-coded or assumed**. Persisted in backend
  state; **refreshed whenever the backend restarts or reconnects**. It is
  the hard ceiling of the adaptive budget (Section 5).
- **Exact tokenization (final):** exposes the server's **tokenizer endpoint**
  so the Context Assembler measures the exact token cost of the assembled
  prompt before every request — no character/line/byte estimates.
- **Single-flight by construction (final):** the adapter serves exactly one
  request at a time and **implements no parallel scheduling of its own** —
  all serialization is the Inference Coordinator's job (Section 2.7); the
  adapter is a leaf, reached only through the coordinator.
  - **Core independence:** no Splash core component references the concrete
    engine or the model name — those are config data consumed only by the
    backend adapter.
  - **Error handling (final):** a non-2xx answer is a typed `http` error that
    carries the HTTP status in `message`; the response-body detail (≤200 chars)
    travels in the technical `cause` only — `message` never carries request or
    response content (Section 9 boundary). The configured API key is redacted
    to `[REDACTED]` inside any stored detail: even if the runtime or a proxy
    reflects the key in an error body, the key never appears in `message` NOR
    `cause`.
- Carries `usage` (tokens in/out) back; `run()` accepts the selected context
  tier (and output reserve) as options.

**6. Worker Contract**
- Builds the worker **system prompt**: role = *implementation worker*; rules
  injected; explicit constraints (Section 8 policy).
- Defines the **patch output schema** the worker must emit and **validates**
  the shape (types, allowed edit kinds) — a first guardrail before the
  Workspace Manager's semantic validation. v1 kinds: `modify` = one or more
  **exact search/replace operations** (standardized; **complete-file
  replacement is not used for normal modifications**), `create` = full
  content, `delete` = path only.
- Informs the worker of the reserved **output headroom** (Section 5) in one
  line, so a very long implementation can self-pace within the reserve.
- Pure function of (context, task, history) → normalized patch + summary.
  No I/O.

**7. Inference Coordinator** *(new, final: global exclusive inference)*
- **Design principle (final):** on this machine, inference is a
  **globally exclusive resource**. Multiple Splash sessions may exist and
  remain open concurrently, but **at most one local-model generation runs at
  any moment**.
- **Single-flight, FIFO.** All Splash inference requests — from any session —
  enter **one process-wide queue**; the coordinator dispatches **FIFO**, and
  only one request owns the backend at a time. The next request starts only
  after the current inference has **completely finished or failed**. No
  configurable parallel-inference mode in v1.
- **Queue semantics (final, no ambiguity):**
  - **Same Splash process** (another Splash session currently owns
    inference): the new request **joins the in-process FIFO queue and waits
    for its turn** — it does not launch another inference; when its turn
    arrives, the call completes with the **normal** task/refine result. This
    is ordinary serialization — **not an error** and not `inference_busy`.
  - **External/conflicting runtime** (the host conflict check detects MLX,
    Ollama, another Splash instance, ...): do **not** enqueue a hidden
    asynchronous job and do **not** run inference — **immediately return
    `status: "inference_busy"`** (Section 3); the session/workspace/state are
    preserved and Claude Code may retry later. **There is no invisible
    asynchronous inference after an MCP call has already returned.**
- **Sits above the backend adapter** — the chain is `Splash session →
  Inference Coordinator → OpenAICompatBackend → local model runtime`. The
  backend adapter itself must not schedule; all serialization lives here.
- **Tracks ownership** — which session's request currently owns the backend.
- **Host conflict check (before every dispatch).** This Mac is a
  **single-owner inference machine**. Before dispatching, the coordinator
  verifies that no conflicting local inference runtime is active — known
  runtimes (another Splash instance, MLX / MLX-LM / MLX-VLM, Ollama) are
  mutually exclusive **unless** the detected process *is* the exact backend
  instance Splash is intentionally configured to use. Splash must never
  intentionally start or use a second competing runtime. **Honesty bound:**
  Splash cannot prevent the OS user from manually launching an unrelated
  runtime *after* Splash has started — so the check runs **again before every
  inference dispatch**, and Splash **refuses to compete** rather than assume
  exclusivity.
- **Lock/state location:** process-wide lock + state under the existing
  Splash root — **`~/.splash/runtime/`** (user-level; config-overridable;
  **never inside the project repository**). The lock protects Splash from
  concurrent *Splash* inference; the external-runtime detection is the
  additional guard against other known runtimes.
- **On a detected conflict** — do **not** start another model and do **not**
  send the request: preserve the Splash session and **immediately return a
  compact `inference_busy` status** (Section 3) — the metadata names the
  detected conflict so Claude Code can understand that inference is
  temporarily unavailable because the host inference resource is occupied,
  and may retry later. **Never source-code content.** (A same-process FIFO
  wait is *not* a conflict — see queue semantics above.)
- **Failure behavior (final):** an inference-runtime conflict must NOT
  destroy the session, destroy the workspace, lose persisted state, trigger
  a second model runtime, or silently fall back to another inference engine.
  The session remains fully resumable.

---

## 3. MCP tools exposed to Claude Code / Codex

Four tools, designed for the **primary client (Claude Code) first**; OpenAI
Codex consumes the same standard MCP surface as the secondary target — no
Codex-specific additions. `splash_diff` is the deliberate addition: it is the
**only** MCP tool that returns generated source/diff content, and only when
the orchestrator asks for it.

| Tool | Purpose | Inputs | Returns |
|------|---------|--------|---------|
| `splash_task` | start/delegate a work item | `task`, `files` (relative to the auto-discovered project root; become the **immutable editable base**), optional `options` | **compact result** + `session_id` |
| `splash_refine` | correction into the *same* session | `session_id`, `feedback`, optional **additional read-only** `files` | **compact result** (same shape; may be `stale_base`) |
| `splash_diff` | on-demand inspection of the actual result | `session_id`, optional `files` filter, optional `stat: true` | **default: unified diff of the entire workspace** (3 context lines, no file argument needed); `files` → narrowed to specific changed files; `stat: true` → statistics only, no source |
| `splash_close` | finalize + end the work item | `session_id` | **absolute** `patch_path` (user-level output dir, never inside the repo), `files_changed`, `diff_stats`, `summary`, `base_status` (no content; **a stale base never blocks the close** — only an operational export failure can fail it, and that preserves the session; **stale ⇒ no auto-apply**) |

**Compact result (shared by `splash_task` / `splash_refine`) — no code content:**
```jsonc
{
  "session_id": "opaque",
  "round": 1,
  "status": "applied" | "partial" | "failed" | "stale_base" | "needs_split" | "max_rounds" | "inference_busy",
  "base_status": "fresh" | "stale",        // pre-round fingerprint check (Section 7.5)
  "stale_files": [ ... ],                   // drifted base files; present only when stale
  "rules_source": "hook" | "CLAUDE.md" | "AGENTS.md" | "CLAUDE.md + AGENTS.md" | "none",
                                            // provenance only (Section 6); rules content is never returned
  "context": {                              // lightweight budget metadata (Section 5) — no content
    "runtime_max_tokens": 0,
    "input_tokens": 0,
    "output_reserve_tokens": 0,
    "selected_context_tier": "64k" | "128k" | "192k" | "runtime_max",
    "truncated_readonly_context": false
  },
  "split_hint": {                           // present only when status == "needs_split"
    "required_input_tokens": 0,
    "available_max_tokens": 0,
    "output_reserve_tokens": 0,
    "pressure_files": ["..."],
    "suggested_groups": [ ["..."] ]         // optional grouping help
  },
  "inference": {                            // present only when status == "inference_busy"
    "conflict": "splash" | "mlx" | "ollama" | "unknown"
  },
  "summary": "short implementation summary + assumptions + open questions",
  "files_changed": ["src/foo.ts", "src/bar.ts"],
  "diff_stats": { "files": 2, "insertions": 34, "deletions": 12 },
  "validation": { "edits_requested": 5, "edits_applied": 5,
                  "rejected": [ { "file": "...", "edit": 2,
                                  "reason": "search text not found | match not unique | overlapping edits" } ] },
  "warnings": ["..."],
  "usage": { "in": 0, "out": 0 }
}
```
- `validation` in v1 is **structural only** (schema + allow-list +
  unique search-match + overlap rejection). No test/lint execution in v1 — the workspace is a *real,
  valid checkout*, which makes a future `splash_verify` (or the orchestrator
  running tests in the workspace dir with its own tools) a natural extension,
  not a redesign.
- **Accept flow (mandatory order):** `splash_close` *first* — it exports
  the final patch to disk (fresh or stale; a **stale base never blocks the
  close** — only an operational export failure can fail it, and that
  preserves the session, Section 7.5) and returns `patch_path`
  (plus summary, `files_changed`, `diff_stats`, `base_status`; no content).
  **Splash itself never applies the patch to the main repo** (v1 has no
  apply operation). *Then* the orchestrator inspects `base_status`: if
  **fresh**, it applies the patch itself with its own git/shell tools — one
  command, `git apply <patch_path>` — spending no tokens reading generated
  code; if **stale** (the main tree drifted since the last successful
  round), it **must not auto-apply** — the patch remains on disk as a
  recovery/review artifact, and the orchestrator inspects/applies it
  manually, handles the conflict itself, or starts a new task from the
  current repo state. The patch file does not exist before `splash_close`
  runs, so the order is fixed.
- **Inspection window:** `splash_diff` requires a live workspace, so it only
  answers *before* `splash_close`. After close, the only inspection artifact
  left is the exported patch file on disk (readable by the orchestrator's own
  tools) — the workspace itself is gone.
- **`stale_base`** — returned when a base file drifted in the main tree since
  session start (Section 7.5). The round is **aborted before the model is
  called**; the workspace and the main repo are untouched. `files_changed` /
  `diff_stats` still describe the last successfully applied round. The session
  stays open: the orchestrator either `splash_close`s it and starts a new task
  from the current repo state, or resolves the drift in the main repo and
  retries (the check passes again once the files match the base fingerprints).
   `splash_task` itself always returns `base_status: "fresh"` (fresh by
   construction).
- **`needs_split`** — the required context (complete editable base files) +
  the minimum output reserve does not fit `maximum_context_tokens`. Splash
  assembles **nothing** and truncates **nothing**: the result carries the
  `split_hint` metadata (tokens, reserve, pressure files, suggested groups —
  **no source content**) so **Claude Code automatically splits the task into
  smaller coherent subtasks**, delegates each as a new `splash_task` (new
  session), preserves dependency ordering between subtasks, then
  reviews/integrates. The user never hand-tunes budgets (Section 5).
- **`max_rounds`** — the configurable guardrail (default 10) was reached. The
  session is **preserved** (persisted, Section 2): the orchestrator can
  continue explicitly, inspect via `splash_diff`, close, or start a new task.
- **`inference_busy`** — a **conflicting external** local inference runtime
  was detected at dispatch (the host inference resource is occupied;
  Section 2.7). The request is **not** enqueued for hidden background work
  and no inference is run — the status is returned **immediately**; the
  session, workspace, and all persisted state are **preserved** (nothing is
  destroyed, nothing is re-routed to another engine); the `inference`
  metadata names the detected conflict and Claude Code may **retry later**.
  **No source-code content** is part of this status. (If instead *another
  Splash session* owns inference — same process — the request simply **waits
  in the FIFO queue** and the call returns the normal result; that is not
  `inference_busy`.)
- **`context` metadata** — lightweight budget telemetry
  (`runtime_max_tokens`, `input_tokens`, `output_reserve_tokens`,
  `selected_context_tier`, `truncated_readonly_context`) so the orchestrator
  understands *why* a round expanded, reduced, or split — without consuming
  frontier tokens. No content is ever included.

**Why the split works:** a small, obviously-correct result can be accepted on
`summary` + `files_changed` + `diff_stats` alone (zero diff tokens). A
suspicious or large result pulls `splash_diff` (optionally per-file) — review
tokens are paid *only when the review actually needs them*.

---

## 4. How a persistent worker session works

- **A session == one delegated work item** (one task) **plus its round
  history** — not a long-lived general chat (that would pollute the local
  model's limited window). Durable on disk; survives process restarts
  (Section 2).
- Internal session state:
  1. Pinned **rules** (always present; resolved once at creation, Section 6).
  2. The **task** statement (stable for the session's life).
  3. The **editable base file set + fingerprints** — captured once at
     creation, **immutable** for the session's life (Section 7.5).
  4. **Additional read-only context files** — optionally added on refine,
     read fresh from the main repo; they inform the worker but never become
     part of (or editable in) the base.
  5. The **rounds**: `patch → validation → feedback → revised patch → ...`
- **Patches are always expressed against the immutable base** (the exact
  project state captured at session creation). On each refine the worker
  emits a *revised full patch set against that same base*; the Workspace
  Manager resets the workspace to base and re-applies it. Validation stays
  deterministic (search strings must match base content, which Splash holds),
  and because the base never moves, a long loop stays deterministic end to
  end — no silent rebase, no drift.
- **Budget discipline (adaptive, Section 5):** the Session Manager retains
  the protected set — rules (soft budget), task, required editable base
  files (**complete, never truncated**), latest feedback, latest validation
  verdict (so the worker sees *why* an edit was rejected — this is what makes
  corrections converge) — and reduces by priority: old refinement history
  first, obsolete previous worker responses next; only then read-only
  reference context. Editable code outranks conversation history.
- **Max rounds:** default guardrail 10 (configurable) — at the limit the
  round returns `status: "max_rounds"`; the session is preserved, never
  destroyed (Section 2).
- `splash_close` finalizes: stale-base check (reported, never blocking),
  export patch (staleness never blocks the close; an operational export
  failure preserves the session), destroy workspace, release the session and
  remove its on-disk state (the exported patch remains, Section 7.6). The
  result's `base_status` gates what the orchestrator may do next: a stale
  close is a successful export but **not** a safe auto-apply (Section 7.5).
- Sessions are independent — no shared *state* across work items. The one
  global resource they share is **inference**: all sessions submit their
  inference to the single-flight **Inference Coordinator** (Section 2.7);
  everything else (state, workspace ops, diff inspection, persistence)
  coexists freely across sessions.

## 5. How project context is selected and transferred

- **Selection is the orchestrator's job.** It passes an explicit `files`
  list in `splash_task` / `splash_refine`. Paths are **relative to the
  session's project root** (the auto-discovered Git toplevel, Section 2 —
  never passed per call in normal use). (A glob/patterns convenience can be
  added later; core = explicit paths.)
- The **Context Assembler** reads exactly those paths from the **main working
  tree** (read-only) — nothing else. The worker can never browse the repo
  beyond what is handed to it.
- **Transfer is adaptive (Section 5):** one ordered block — `rules` (pinned,
  8,192-token soft budget) + `task` + base files (**complete content** —
  never truncated) + any additional read-only files (content, read fresh) —
  exact-measured against the runtime's `maximum_context_tokens` minus the
  output reserve, then placed in the smallest fitting tier. Only **read-only
  reference** context may be truncated (reduction priority, Section 5);
  required editable code is never cut silently — if it cannot fit, the result
  is `needs_split` (Section 3).
- **Two kinds of files, different lifetimes** (Section 7.5):
  1. **Editable base files** — the `files` passed to `splash_task`. Captured
     at creation, **immutable**, and the only existing paths a patch may
     modify (plus new files a patch declares).
  2. **Additional read-only context** — `files` optionally passed on
     `splash_refine`. Read fresh from the main repo when added; they give the
     worker *information* but **do not mutate the base** and are **not
     writable** (validation rejects edits targeting them).
  If a newly added file must become editable, **v1 requires a new session**
  (a new session captures a fresh base that includes it) — no expanding or
  rebasing an existing one.

## 6. How project rules are loaded (final: fallback resolution)

Rules are resolved **once at session creation** by a deterministic
fallback chain:

1. **Priority 1 — session/hook-supplied rules.** The primary Claude Code
   integration may supply project rules (e.g. a session-start hook). Splash
   must **not blindly assume the hook ran**: it verifies it actually received
   a **valid, non-empty** rules payload. When valid supplied rules exist,
   they are the **primary rules source**.
2. **Priority 2 — repository discovery (fallback).** If no valid rules were
   supplied, Splash discovers project instruction files itself: `CLAUDE.md`
   and/or `AGENTS.md` **in the project/repository root** (a deterministic
   discovery rule — no crawling of unrelated directories). If both exist,
   they are **combined in a deterministic order** (`CLAUDE.md` first, then
   `AGENTS.md`) and **labeled with their source** in the context block.
3. **`none`.** If neither source yields rules, the session proceeds with no
   pinned rules and records it; the worker prompt simply omits the rules
   block.

The resolved rules are **stored in the session and pinned into the local
worker prompt on every round** (by the Worker Contract), separate from (and
budgeted apart from) the task context. Default **soft budget: 8,192
tokens** — if rules exceed it, redundant rule material is compacted
**deterministically where safe** and a warning is recorded; **safety-critical
or task-critical rules are never silently removed** (Section 5). This
satisfies "project rules must be **explicitly** passed to the local model" —
a first-class, always-present input, not an assumption.

**Provenance metadata.** The session records where the rules came from:
`hook` | `CLAUDE.md` | `AGENTS.md` | `CLAUDE.md + AGENTS.md` | `none`. This
lightweight `rules_source` value **may appear in the compact task result** —
but the **full rules content is never returned to the orchestrator** (it
already *has* its rules; returning them would burn tokens for nothing).

---

## 7. The isolated workspace

### 7.1 Options considered

| Option | Token efficiency | Safety | Speed | Reviewability | Verdict |
|--------|-----------------|--------|-------|---------------|---------|
| Full temp project copy | Poor — must keep *two* copies (pristine base + working) to diff; diffing needs a homegrown comparator | Good (isolated) | Poor — copies the whole tree (and `.git`) per task | Weak — no native diff | Rejected |
| In-memory virtual workspace | Fair | Good | Fair | Weak — no native diff/reset primitives; reinvents what git gives for free; memory pressure on large files | Rejected |
| **Git worktree** | **Best** — `git diff` / `--stat` native and exact; reset is `git reset --hard base`; export is one diff command | **Good** — standard git primitive, separate directory, main checkout untouched by construction | **Best** — `git worktree add` shares the object database (checkout, not a copy); create/reset/destroy are all O(files), no data duplication | **Best** — the diff *is* the canonical review artifact; `--stat` for summaries, filtered diffs on demand | **Chosen** |

### 7.2 Choice: git worktree (v1 is git-only)

- **v1 supports Git repositories only.** The workspace is a `git worktree`
  of the project repo at a detached base commit (Section 7.3) — a *real,
  valid checkout* in its own directory.
- **The Workspace Manager in v1 has exactly one implementation:
  `GitWorktreeWorkspace`.** The non-git directory-snapshot fallback is
  **removed from v1**; non-git support may be reconsidered in a future
  version.
- **If Git repository discovery fails** (no `repo_root` override, or the
  override is not a valid Git repository), `splash_task` returns a **clear
  project/configuration error** — nothing is created (Section 2).

Reasoning, mapped to the four criteria:
1. **Token efficiency** — `git diff` and `git diff --stat` are free and exact,
   which is what makes the *compact response* (stats) and the *on-demand
   `splash_diff`* possible without inventing a diff engine. The exported
   `.patch` file lets the frontier merge with one `git apply` and read zero
   generated code.
2. **Safety** — a worktree is a separate directory; the main checkout is
   structurally untouched. The base commit is made on a **detached HEAD**
   (no branch ref, no ref pollution; the commit is transient garbage that git
   GC reclaims), so the project repo gains nothing permanent. Cleanup is the
   standard `git worktree remove`.
3. **Speed** — no object copying (the object DB is shared with the main
   repo); creation is a checkout of files, reset is one git command, destroy
   is a directory removal. This is the cheapest of the three options for
   create/destroy, which happens on *every* task.
4. **Reviewability** — the worktree diff is the same artifact a developer
   reviews; the orchestrator can inspect whole, per-file, or stats-only, and
   can even `cd` into the workspace with its own tools if it wants to
   inspect files directly.

### 7.3 Workspace lifecycle

```
create(task):
  git worktree add --detach <wsDir> HEAD
  apply the main repo's EXACT working-tree state relative to HEAD:
    git diff HEAD --binary --full-index    # staged AND unstaged — plain
                                           # `git diff` is NOT used (it omits
                                           # staged changes)
  copy the SELECTED untracked files (editable base + read-only context set)
    into <wsDir> — including git-IGNORED files the secret/safety policy
    allows (they must still be representable in the isolated base)
  git -C <wsDir> add -A && git commit --allow-empty -m "splash base <session_id>"
      # base-commit hygiene (required): hooks disabled for this command,
      # commit.gpgsign=false, deterministic Splash author/committer identity
      # (never the user's git name/email), detached HEAD, no branch/tag/ref
  record the base fingerprint of every editable base file:
    existence + type + relevant mode + content        (Section 7.5)
  → HEAD of <wsDir> is now the BASE (== the exact main working-tree state
    visible to Claude Code at session start)
  → the BASE IS IMMUTABLE from here on (Section 7.5)
  → the isolated base EXACTLY matches the content given to the worker

round(n, patch):
  stale-base check (Session Manager, Section 7.5)   # aborts the round if stale
  git -C <wsDir> reset --hard <base>                # (1) tracked state back to
                                                     # the immutable base — never
                                                     # re-synced from the main repo
  remove the previous round's worker-created paths  # (2) SCOPED to the known
      that are absent from the immutable base        # worker-created set — NEVER
                                                     # a broad `git clean`
  validate(patch) → apply the validated FULL patch set    # (3) each refine is a
  git -C <wsDir> add -N -- <created paths>              #   full replacement against
                                                     #   base; created files marked
                                                     #   intent-to-add (stay uncommitted)
  → workspace now holds base + latest full patch set (created files included
    in every diff/stat/export via intent-to-add)

diff / stat:
  git -C <wsDir> diff -U3 <base> [--stat] [-- <paths>]
      # splash_diff defaults (final): whole workspace, 3 context lines,
      # no file argument needed for normal review; `files` → per-file filter;
      # `stat: true` → statistics only (no source)
      # the diff is exactly the task's contribution (pre-existing delta excluded)
close():
  stale-base check                                # reported in the close result, never blocking
  mkdir -p <outputRoot>/patches/<repo-id>/        # created automatically
  git -C <wsDir> diff --binary --full-index <base> > <outputRoot>/patches/<repo-id>/<session-id>.patch
      # COMPLETE patch: modifications + deletions + worker-created files (via
      # intent-to-add) + supported binary diffs; normal configured diff context
      # (splash_diff may still default to -U3); default outputRoot = ~/.splash
      # — OUTSIDE the project repo; exported on every successful close, fresh
      # OR stale (a stale base never blocks it)
  # if THIS export step fails (fs / permission / disk-space / git I/O): do NOT
  # destroy the workspace or the persisted session — return an operational
  # error so the session stays recoverable (Section 7.5)
  git worktree remove --force <wsDir>
  # the patch file REMAINS on disk after the workspace is destroyed;
  # close returns its absolute patch_path; auto-apply only on a fresh
  # close (Section 7.5); location rules in Section 7.6
```

Note the base-capture step: Claude Code is usually mid-work with uncommitted
changes. Basing on `HEAD` alone would (a) make the worker patch against stale
content and (b) make the final diff include the user's pre-existing changes.
Capturing HEAD + the **exact working-tree delta** (staged + unstaged,
`git diff HEAD --binary --full-index`) + the selected untracked files as the
base solves both: the worker's search strings match exactly what it was
shown, and the exported patch contains *only* the task's contribution. It
applies cleanly to the main checkout via `git apply` **only while the main
checkout still matches base** — which is exactly what
`base_status: "fresh"` on close certifies; a stale close therefore never
auto-applies (Section 7.5).

**Base-commit hygiene (required).** The transient base commit is
infrastructure, not a normal project commit. Creating it must: disable commit
signing (`commit.gpgsign=false` equivalent); disable repository Git hooks for
the command; **not depend on the user's configured Git name/email** (a
deterministic Splash-local identity instead); remain on a detached HEAD; use
`--allow-empty`; and create **no permanent project branch/tag/ref**. The
exact Node/git invocation is an implementation detail; the behavior is
required.

### 7.4 Patch validation (the safety boundary)

The worker's output is **data, never code** — it is parsed into a typed patch
structure and checked before any effect:

1. **Schema** (Worker Contract): valid edit kinds — `modify` = one or more
   **exact search/replace operations** against the immutable base
   (standardized; **complete-file replacement is not used for normal
   modifications** — Zeus contains very large source files), `create` (full
   content), `delete` (path only, editable base paths).
2. **Allow-list** (Workspace Manager): every path must be in the session's
   **editable base set** (captured at creation), or be a *new* file
   (create). Additional read-only context files are **not** writable — edits
   targeting them are rejected. Nothing else.
3. **Path bounds**: workspace-relative, no `..` escape, no absolute paths, no
   symlink targets outside the workspace.
4. **Match (pre-apply)**: every `search` string is validated against the
   **immutable base** content of that file; each required match must be
   **unique**; **overlapping edit ranges are detected and rejected** (an
   ambiguous edit is rejected, not applied); validated edits are then
   **applied deterministically** (order-independent). This keeps local-model
   output small and prevents edit-order drift.
5. Rejected edits never touch the workspace; they are reported in the compact
   result (`validation.rejected`) and fed back into the next round so the
   worker can correct them.

The local model itself still has: **no shell, no git, no arbitrary filesystem
access, no direct repository write access.** It emits text; Splash decides.
Everything that writes — including git — is the Workspace Manager, confined to
the workspace (+ the patch export path).

### 7.5 Immutable session base + stale-base detection

**The rule.** When `splash_task` creates a session, Splash captures the exact
project state used for that task (the base, Section 7.3) **plus a fingerprint
of every editable base file — existence + type + mode + content**. For the
entire lifetime of the session:

- the base is **immutable** — no operation updates, re-syncs, or rebases it
  from the main repository;
- `splash_refine` always operates against that **same** base; the workspace
  is only ever *reset to* it, never refreshed;
- the worker is always shown the base content of editable files, so its
  search strings and the validator's match check refer to one fixed state.

**Stale-base detection.** The immutable fingerprint of every editable base
path represents **existence + file type + relevant Git/file mode + content**
— matching bytes alone is **not** fresh if the path type or a relevant mode
changed. Before `splash_refine` and `splash_close`, the Session Manager asks
the Context Assembler to record the *current* state (existence, type, mode,
content) of the base files in the main working tree and compare it against
the captured fingerprints (a read-only check; nothing is modified). The
first round is fresh by construction (the base is captured from the live
tree at that moment); the check is what matters from round 2 on, and at
close.

**Created-path collision (final).** Once the worker patch contains a
`create` operation for a path, that path has an **expected base state of
absent**. Before refine/close, if such a path has **appeared independently in
the main working tree**, the session must be considered **stale for that
path** — this prevents a fresh close from exporting a patch that would
collide with a newly created main-repo file.

- **Fresh** (all fingerprints match — content, existence, type, mode; no
  created-path collision) → the round proceeds normally; the result carries
  `base_status: "fresh"`.
- **Stale** (any base file drifted in content, existence, type, or mode — or
  a worker-created path appeared in the main tree) → the round is **aborted before the model
  is called**; the workspace is untouched; the main repo is untouched. The
  result is a compact conflict status: `status: "stale_base"`,
  `base_status: "stale"`, `stale_files: [...]`, plus the previous round's
  `files_changed` / `diff_stats`. Nothing is overwritten, rebased, or merged.

**The orchestrator then decides** (v1 implements **no** automatic
rebase/merge):

- `splash_close` the stale session and start a **new task from the current
  repository state** (a new session captures a fresh base), or
- resolve the drift itself in the main repo (e.g. revert the drifted files to
  their base state) and call `splash_refine` again — the check passes once
  the fingerprints match again.

**Stale close (final).** `splash_close(session_id)` **must be allowed even
when the session base is stale** — a stale base must never make a Splash
session impossible to close. When `splash_close` detects a stale base, it:

1. exports the final base-relative patch normally;
2. returns its absolute `patch_path`;
3. returns `base_status: "stale"`;
4. includes `stale_files` where useful;
5. destroys the isolated workspace;
6. removes the persisted live-session state;
7. leaves the exported patch on disk as the recovery/review artifact.

**Critical safety rule.** A stale close **must never** result in automatic
application of the patch to the main repository. The main tree may have
drifted between the last successful round and the close, so the orchestrator
treats `base_status: "stale"` as: **export succeeded, but automatic apply is
unsafe.** Claude Code may then: inspect the exported patch; resolve the
main-repo conflict itself; manually apply compatible parts (e.g. a three-way
apply, or taking the parts that still fit); discard the patch; or start a new
Splash task from the current repository state (a new session captures a fresh
base). Splash itself still never modifies the main repository.

**Failure distinction (final).** Do not read "stale never blocks close" as
"`splash_close` can never fail": filesystem, permission, disk-space, or
git/I/O errors may still produce a normal operational failure. The guarantee
is specifically: **stale-base status does not block close.** If the patch
**export itself fails**, Splash does **not** destroy the workspace or the
persisted session state — it returns an operational error so the session
remains recoverable. This prevents losing the only copy of the worker's
result.

**Design principle.** *Freshness controls whether the exported patch is safe
to automatically apply; freshness does not control whether the session may be
closed.*

**Editability boundary.** A file is editable only if it was in the task's
original `files`. Additional read-only files added on refine never become
editable; making one editable requires **starting a new session**. This is the
v1 trade-off: coarser edit granularity in exchange for a fully deterministic,
drift-free correction loop.

### 7.6 Exported patch location (final)

- Patch files are stored **outside the project repository** — **never** a
  project-local `.splash/` directory (no Splash artifact may modify or
  pollute the repo). Default user-level layout:
  `~/.splash/patches/<repo-id>/<session-id>.patch`, where:
  - `repo-id` = a **deterministic digest** of the repository identity — a
    short hash of the normalized absolute repo root path (the discovered
    toplevel, Section 2). Stable per repository; no raw filesystem path in
    the filename.
  - `session-id` = the Splash task session identifier.
- The **output root is configurable** (`outputRoot`, default `~/.splash`);
  all required directories are **created automatically** as needed.
- `splash_close` returns the **absolute `patch_path`**; the file **remains on
  disk** after the workspace is destroyed — it is the recovery/review
  artifact (Section 7.5).
- **Complete-patch semantics (final):** the exported patch is the equivalent
  of `git diff --binary --full-index <base>` — it includes modifications,
  deletions, worker-created files (made visible by intent-to-add, Section
  7.3), and supported binary Git diffs, with the normal configured diff
  context. (`splash_diff` may still default to `-U3`; that is a display
  choice, not the export format.)

## 8. The review / correction loop

```
loop:
  r = (first round)  splash_task(task, files)                        → compact result
       else          splash_refine(session_id, feedback[, files])    → compact result
  if  r.base_status == "stale":        # a base file changed in the main tree
       orchestrator decides: splash_close + start a new task from the
       current repo state,  or  fix the drift in the main repo and retry refine
  if  r.status == "needs_split":       # required context + reserve > runtime max
       # do NOT retry the same request — Claude Code splits the task into
       # smaller coherent, dependency-ordered subtasks, delegates each as a
       # new splash_task (new session), then reviews/integrates (Section 5)
  if  r.status == "max_rounds":        # guardrail (default 10) — session preserved
       orchestrator decides: continue explicitly, inspect (splash_diff),
       close, or start a new task
  if  r.status == "inference_busy":    # a conflicting EXTERNAL runtime occupies the host
       # (a same-process FIFO wait is NOT this status — it returns the normal
       # result); session + workspace + state preserved — the orchestrator
       # retries when appropriate; nothing is re-routed to another engine
       # (Section 2.7)
  if  r.base_status == "fresh":
       orchestrator reviews  r.summary + r.files_changed + r.diff_stats (+ r.validation)
       if  it needs to see the code:  splash_diff(session_id[, files])   ← the only content pull
       if  accepts:
             c = splash_close(session_id)   # a stale base NEVER blocks the close:
                                            # exports the final patch (fresh or
                                            # stale), destroys the workspace,
                                            # returns patch_path + summary + stats
                                            # + base_status (an operational
                                            # export failure preserves the session)
            if  c.base_status == "fresh":
                 git apply <c.patch_path>  # the orchestrator's OWN git tool —
                                            # Splash never applies to the main
                                            # repo (v1: no apply operation)
            else:                          # stale — main tree drifted since the
                 # do NOT auto-apply; the patch stays on disk as a
                 # recovery/review artifact; the orchestrator inspects/applies
                 # manually, handles the conflict, or starts a new task
            break
       else:
            feedback = "src/foo.ts: line 42 wrong, use X; do NOT touch bar.ts"
            continue   (same session, same immutable base; worker also sees
                        the round's validation verdict)
```

Worker **policy** (Worker Contract: prompt + output validation):
- **Implement only.** Satisfy the task and the feedback; no refactoring, no
  drive-by cleanup, no new abstractions.
- **Minimum diff.** Smallest change that works; never reformat untouched code.
- **No destructive operations.** Architecturally impossible (no fs/shell/git)
  — the worker can only emit patch entries.
- **Stay in scope.** Only the **editable base set** + declared new files;
  additional read-only context is reference material, not a target.
- **Be explicit** about assumptions and anything it could not do, in `summary`.

Each round costs the frontier a few hundred tokens (compact result) plus
whatever diff it *chooses* to pull; generation happens locally. That asymmetry
is the token-savings mechanism.

**The context principle (final):** Splash does not force Zeus-sized tasks
into a fixed budget. It **measures** the real task (exact tokenization),
**adapts** to the runtime's actual capacity (tiers up to
`maximum_context_tokens`), **preserves** required editable code (complete,
never silently truncated), and asks Claude Code to **split** the task
automatically — only when it genuinely cannot fit.

## 9. What should NOT be sent — two boundaries

**To the local model** (via Context Assembler / Worker Contract):
- **Secrets & credentials** — `.env`, keys, tokens, passwords, certs:
  redacted (pattern pass: `sk-...`, `AKIA...`, private-key blocks) and
  secret files skipped entirely.
- **The orchestrator's system prompt / internal reasoning** — never proxied.
- **Unrelated code** — only the orchestrator-selected `files`; no repo crawl.
- **Editability labels** — files added on refine are presented to the worker
  explicitly as *read-only reference*; the allow-list (Section 7.4)
  independently rejects any edit targeting them.
- **The repository in its entirety**; any **PII** in included files (redaction).

**To the frontier** (via MCP responses) — the new boundary:
- **Generated source code** — never in `splash_task` / `splash_refine` /
  `splash_close` responses. Only ids, summary, file list, stats, warnings.
- **Rules content** — never in any response. The orchestrator already *has*
  its rules; only the `rules_source` provenance value is returned (Section 6).
- **`inference_busy` status** — never includes source or rules content; only
  the compact conflict metadata (Section 3).
- The full diff exists *only* inside the workspace, retrievable solely via
  `splash_diff` (which the orchestrator calls when — and only when — it
  decides to review content) or the exported patch file on disk.
- **Typed error metadata only** — MCP tool responses carry only the typed
  error metadata: `kind` (closed vocabulary) + the safe `message` (HTTP status
  + endpoint path) + `status`; response-body fragments (≤200 chars) exist only
  in the technical `BackendError.cause` channel, which never appears in MCP
  responses — `cause` is developer-log-only.

Enforcement: Splash is the only reader of the main repo (explicit files,
redaction) and **never a writer** (v1 has no apply operation); the worker has
zero I/O; response builders structurally omit code.

---

## 10. Directory structure

TypeScript / Node (**final** — confirmed in the runtime decision; matches the
MCP SDK and the orchestrators' ecosystem). The package's `engines` field is
Node `>=20`, and the test suite is compiled with `tsc` before running —
Node's native TypeScript stripping is not required.
Core is **engine- and transport-agnostic**; backends and transports are leaf
adapters.

```
splash/
├── src/
│   ├── index.ts                     # entry: build server, attach transport, register tools
│   ├── server.ts                    # transport-agnostic core; v1: stdio adapter
│   ├── config.ts                    # backend, repoRoot (override), rules discovery, adaptive budgets (tiers, output reserve, rules soft budget, max_rounds, explicit overrides), redaction, outputRoot (default ~/.splash)
│   ├── tools/
│   │   ├── task.ts                  # splash_task
│   │   ├── refine.ts                # splash_refine
│   │   ├── diff.ts                  # splash_diff  (the only content-returning tool)
│   │   └── close.ts                 # splash_close (export patch + destroy)
│   ├── session/
│   │   ├── SessionManager.ts        # lifecycle, map<id, Session>, round budget/eviction, restore by session_id
│   │   ├── Session.ts               # rules, task, base+fingerprints, read-only ctx, rounds, usage
│   │   └── SessionStore.ts          # disk persistence: ~/.splash/sessions/<session-id>/ (source of truth)
│   ├── context/
│   │   ├── ContextAssembler.ts      # read main working tree, order, budget, emit block
│   │   └── redact.ts                # secret/PII patterns + skip-list
│   ├── workspace/
│   │   ├── Workspace.ts             # create(+fingerprints), validate, apply, reset, diff, stat, export, destroy
│   │   ├── GitWorktreeWorkspace.ts  # the ONLY v1 implementation (git-only; detached base commit; all git here)
│   │   └── validate.ts              # allow-list, path bounds, unique search-match, overlap rejection
│   ├── backend/
│   │   ├── InferenceCoordinator.ts  # global single-flight FIFO queue; host conflict check; ~/.splash/runtime/ lock + state
│   │   ├── InferenceBackend.ts      # interface: run(messages, opts) -> {content, usage} — single-flight, no internal scheduling
│   │   └── OpenAICompatBackend.ts   # the ONLY v1 impl (OpenAI-compatible HTTP)
│   │   # future leaf adapters (NOT in v1): OllamaBackend.ts, ...
│   └── worker/
│       ├── WorkerContract.ts        # prompt + policy + shape validation
│       └── result.ts                # patch schema + compact result schema
├── config/
│   └── splash.example.json          # documented example config
├── package.json
├── tsconfig.json
└── README.md
```

**User-level runtime state** (never inside any project repository; all
roots config-overridable, default `~/.splash`):

```
~/.splash/
├── patches/<repo-id>/<session-id>.patch   # exported patches (Section 7.6)
├── sessions/<session-id>/                 # persisted session state (Section 2)
└── runtime/                               # Inference Coordinator lock + state (Section 2.7)
```

## 11. Implementation build order

Incremental — the *minimum loop with a real workspace* first, then the rest.

1. **Server skeleton** — MCP core + stdio adapter + config + no-op tool.
2. **Inference Backend** — the `InferenceBackend` interface +
    `OpenAICompatBackend` (the only v1 impl; `base_url` + `model` + optional
    `api_key` from config); a `run()` round-trip; **runtime status**
   (`maximum_context_tokens`, refreshed on reconnect) + **tokenizer
   endpoint** (Section 5); **single-flight adapter, no internal scheduling**.
3. **Inference Coordinator** — global single-flight FIFO queue (same-process
   waits are ordinary queue waits); `~/.splash/runtime/` lock/state; host
   conflict detection (another Splash instance / MLX / Ollama; re-checked
   before every dispatch) → immediate `inference_busy` (Section 2.7).
4. **Worker Contract + schemas** — prompt/policy builder; patch schema
   (`modify` = exact search/replace ops; `create` = full content; `delete` =
   path only); compact-result schema.
5. **Workspace Manager (git worktree — git-only v1)** — repo-root discovery +
   create + **exact base capture** (`git diff HEAD --binary --full-index` +
   selected untracked, incl. allowed git-ignored; base-commit hygiene: hooks
   off, deterministic Splash identity) + **fingerprint (existence + type +
   mode + content)** + validate (unique match, overlap rejection) + apply
   (+`add -N` intent-to-add) + **scoped reset cleanup** + diff/stat +
   **complete `--binary --full-index` export**/destroy. *(The safety core.)*
6. **`splash_task` end-to-end** (context simple) — task → worker → patch →
   validated-apply → **compact result**. *(First real loop.)*
7. **Context Assembler + redaction + adaptive budget** — exact tokenization,
   tier selection, output headroom, rules soft budget, reduction priority,
   `needs_split` (Section 5).
8. **Rules loading** — pinned into the worker prompt.
9. **Session Manager + `splash_refine`** — rounds, scoped reset + full
   patch-set re-apply, **stale-base check** (content + existence/type/mode +
   created-path collision, Section 7.5), read-only context on refine, history
   eviction by reduction priority, **`max_rounds` guardrail** (Section 5),
   **disk persistence + recovery** (source of truth; surviving worktree
   reused if it matches, else recreated, Section 2), concurrent sessions
   sharing the coordinator.
10. **`splash_diff` + `splash_close`** — on-demand diff; **complete
    `--binary --full-index`** patch export; destroy (stale never blocks; an
    export failure preserves the session).
11. **End-to-end** on a real repo + real local model: verify compact
    responses, on-demand diff, `git apply` merge into the main checkout,
    refine-loop convergence with bounded token growth, the stale-base path
    (external edit of a base file → `stale_base` → close + new task),
    **session recovery after a process restart** (surviving worktree reused
    when it matches; otherwise recreated from the persisted base), and
    **concurrency** (two open sessions: one generation at a time, the other
    waits in the FIFO; a conflicting external runtime → immediate
    `inference_busy`, no state loss).
12. **README + `splash.example.json`** + wiring notes for Claude Code / Codex.

---

## Non-goals (explicitly out of scope, to stay minimal)

- **v1: Splash never modifies the main repository** — not the main repo, not
  anywhere else (its only write outside the workspace is the exported
  `.patch` file in the **user-level output dir**, default `~/.splash`, never
  inside the repo; Section 7.6). **`splash_apply` and
  `close(apply: true)` are NOT in v1** — merging back is the orchestrator's
  own act: `git apply <patch_path>` with its own git/shell tools, **only on a
  fresh close**; a stale close never auto-applies (Section 7.5). A future
  version may add an apply operation if there is a demonstrated need —
  explicitly out of scope for v1.
- The worker never runs a shell, git, or touches the filesystem (Splash does
  those things *on its behalf*, inside the workspace, behind validation).
- No test/lint execution in v1 (the valid-checkout workspace is the extension
  point; the orchestrator may also run checks in the workspace dir itself).
- No runtime multi-model routing (one configured backend; swappable via config).
- **No parallel local inference** — v1 is strictly **single-flight** (one
  generation at a time, global FIFO; Section 2.7). No configurable
  parallel-inference mode; a host conflict never triggers a second runtime or
  a silent fallback to another engine.
- **No fixed context budgets** — v1 budgeting is fully adaptive (exact
  tokenization + runtime capacity + tiers; Section 5). Fixed values exist
  only as optional explicit overrides for debugging.
- No cloud/remote model by default (local only; the interface allows others).
- No HTTP/SSE transport in v1 (stdio only; core stays decoupled).
- **No automatic rebase/merge of a stale base** — v1 detects drift, reports
  `stale_base`, and defers to the orchestrator (close + new task, or fix the
  drift). Determinism over convenience.
- No external database or queue — session persistence is **plain files**
  under `~/.splash/sessions/<session-id>/` (Section 2); no DB, no queue, no
  background service.
- No UI, dashboard, or telemetry.
- **v1 is git-repos-only** — the Workspace Manager has exactly one
  implementation (`GitWorktreeWorkspace`); the non-git snapshot fallback is
  out of v1 (a future version may reconsider non-git support; Section 7.2).

---

## 12. Revised component list

1. **MCP Server** — stdio transport (v1) + 4 tools + config; transport-agnostic core; hosts the Inference Coordinator (Section 2.7).
2. **Session Manager** — session lifecycle, round history, pinned rules/task, adaptive budget enforcement + reduction priority, **max_rounds guardrail**, **immutable base + fingerprint stale check**, **disk persistence (source of truth, `~/.splash/sessions/<session-id>/`) + recovery (surviving worktree reused if it matches, else recreated; never depends on volatile state)**.
3. **Context Assembler** — read-only main-repo reader, rules (soft budget), **adaptive context budget** (exact tokenization, tiers, headroom, reduction priority, `needs_split`), secret redaction.
4. **Workspace Manager** — **git-only v1, one implementation (`GitWorktreeWorkspace`)**; isolated workspace lifecycle; repo-root discovery (read-only git query); immutable base-capture (exact working-tree delta + selected untracked; hooks off, deterministic Splash identity; fingerprints = existence+type+mode+content); patch validation (unique match, overlap rejection); apply + `add -N` intent-to-add; **scoped reset cleanup** (never a broad `git clean`); diff/stat; complete `--binary --full-index` export; destroy. The only writer/git runner, confined to the workspace (+ read-only main-repo queries).
5. **Inference Backend** — pluggable local-model adapter; **v1: `OpenAICompatBackend` only** (OpenAI-compatible HTTP; `base_url` + `model` + optional `api_key` configurable, defaults `http://127.0.0.1:8000` + `incoai/Qwen3.8-27B-Splash` — in v1 `base_url` is a server-origin URL: non-root path prefixes, query strings, fragments, and embedded credentials (`user:pass@`) are rejected at config load; Ollama etc. = later leaf adapters); **runtime `maximum_context_tokens` (authoritative, refreshed on reconnect) + tokenizer endpoint**; **single-flight, reached only through the coordinator (no internal scheduling)**.
6. **Worker Contract** — worker prompt + policy + patch output schema.
7. **Inference Coordinator** — process-wide **single-flight FIFO** queue over the backend (same-process waits are ordinary queue waits); **host runtime conflict check** (another Splash / MLX / Ollama; re-checked before every dispatch; never competes, never falls back) → **immediate `inference_busy`** (no hidden background queue); lock/state under `~/.splash/runtime/`; conflicts never destroy session/workspace/state.

## 13. Revised MCP tool list

| Tool | Returns |
|------|---------|
| `splash_task(task, files, options?)` | compact result + `session_id` (no code content) |
| `splash_refine(session_id, feedback, files?)` | compact result, same shape; `files` = additional **read-only** context (never base); may return `status: "stale_base"` |
| `splash_diff(session_id, files?, stat?)` | default: whole-workspace unified diff (3-line context); `files`: per-file filter; `stat`: stats only — the **only** content-returning tool, on demand |
| `splash_close(session_id)` | **absolute** `patch_path` (user-level output dir, never inside the repo), `files_changed`, `diff_stats`, `summary`, `base_status` (no content); **a stale base never blocks the close** + destroys workspace (an operational export failure preserves it); **stale ⇒ no auto-apply** (patch stays on disk) |

## 14. Chosen workspace strategy — and why

**Git worktree — v1 is git-only.**

- **Token efficiency:** native `git diff`/`--stat` power the compact response
  and on-demand `splash_diff`; the exported `.patch` lets the frontier merge
  with one `git apply` and read zero generated code. No homegrown diffing.
- **Safety:** separate directory; main checkout untouched by construction;
  base commit on detached HEAD (no ref pollution); cleanup is the standard
  `git worktree remove`. All writes happen inside the workspace, behind
  allow-list + match validation; rejected edits never land.
- **Speed:** the object database is shared — create/reset/destroy are file
  operations, not copies; far cheaper than a full project copy per task.
- **Review:** the worktree diff is the canonical, minimal, exact artifact
  (whole / per-file / stats), and the workspace is a real checkout the
  orchestrator can also inspect directly.

Rejected: full temp copy (slow create; needs a second pristine copy to diff;
no native diff) and in-memory workspace (reinvents diff/reset; memory
pressure). Cost accepted (final): **v1 requires a Git repository** (true for
the target projects); non-git support may be reconsidered in a future
version.

## 15. Remaining human decisions

**None — all design decisions are final for v1** (git-only workspace,
adaptive context budget, runtime + concurrency, stale-close behavior,
inference-queue semantics, and every other item above). DESIGN.md is
**ready for implementation** per the Section 11 build order.

