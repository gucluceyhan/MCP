# Splash MCP

Let a frontier coding agent hand scoped implementation work to a local LLM, without giving that local model any control over your repository.

> **Status: early / experimental (v0.1.0).** All four tools are implemented and covered by the automated test suite. The first end-to-end run against a real local model has **not** been completed yet. Expect rough edges; interfaces may change before 1.0.

---

## What is Splash MCP?

Splash MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server (stdio). A frontier orchestrator such as Claude Code or OpenAI Codex uses it to send well-scoped implementation tasks to a model running on your own machine. The local model gets only the files the orchestrator selects, after secret redaction. It returns a structured patch, and Splash validates that patch and applies it inside an isolated Git worktree. The orchestrator does not get the generated source back. It gets compact review metadata: status, summary, changed files and diff statistics. It reads the actual diff only when it chooses to. So frontier tokens go to reviewing the work, not to generating code. When the orchestrator accepts the result, Splash exports a patch file and the orchestrator applies it with `git apply`. The local model never gets a shell, Git, or filesystem access, and Splash never writes to your working tree.

Terminology used in this document:

| Term | Meaning |
|------|---------|
| **Splash MCP** | This repository: the MCP server (`serverInfo.name` = `splash`, version `0.1.0`). |
| **Splash engine** | The local inference runtime that serves the model, [incoai/splash](https://github.com/incoai/splash). It is Splash MCP's default backend. |
| **Orchestrator** | The frontier agent that calls the tools. Claude Code is the primary client. Codex is supported through standard MCP. |
| **Worker** | The local model that writes the patch. |
| **Session** | One delegated task, its isolated worktree, and its refinement rounds. |

## Design principles

Each item below matches a design decision in [DESIGN.md](DESIGN.md) and is implemented in `src/`.

- **Never writes to your repository.** Edits happen only in a dedicated Git worktree under `<outputRoot>/sessions/<session-id>/workspace` (default `~/.splash/...`). Splash has no apply operation. It does not modify your working tree, index, branches or refs.
- **Never applies its own patch.** `splash_close` exports the patch to a file outside the repository. Applying it is up to the orchestrator, or you.
- **Code reaches the orchestrator only on request.** `splash_task`, `splash_refine` and `splash_close` return metadata only. `splash_diff` is the only tool that returns generated content, and only when it is called.
- **Secrets stay out of the prompt.** Before anything is sent to the model, Splash redacts common secret patterns and personal data (see [Safety model](#safety-model)). Files classified as secret files (for example `.env`, `*.pem`, `id_rsa`, `credentials.*`) are replaced by a placeholder entirely. The worker cannot write a redaction placeholder back into a file.
- **Project rules are passed explicitly.** Splash resolves the rules once per session: either rules supplied by the caller, or the root `CLAUDE.md` / `AGENTS.md`. It pins them into every worker prompt. Responses never include the rules content, only a `rules_source` label.
- **Structural patch validation.** Each edit is checked before it touches the worktree: the target must be in the editable set or be a new file, each `search` must match the base exactly once, and edits must not overlap. Rejected edits are reported and never applied.
- **Immutable base and stale detection.** A session captures the exact state of its editable files when it is created. Before every refine and at close, Splash compares the live files (existence, type, mode, content) against that base. Drift is reported as `stale`. It is never merged or rebased silently.
- **Durable sessions.** Session state is persisted to disk. After a server restart, a session is recovered by its `session_id`. Splash reuses the session's worktree if it is still valid and recreates it otherwise.
- **One generation at a time.** All inference goes through a single-flight FIFO coordinator. If Splash detects a competing local runtime (another Splash engine, MLX, Ollama), it returns `inference_busy` immediately instead of competing for the machine.
- **Content-free errors.** Tool errors carry only a stable `kind` and a short, safe message. They never include stderr, response bodies, file content or API keys.

## Requirements

| Requirement | Details |
|-------------|---------|
| **macOS on Apple Silicon** | Required by the Splash engine, which is distributed as a Homebrew package for Apple Silicon. Splash MCP itself is plain Node.js, but v1 targets this setup only. |
| **Node.js 20 or newer** | `engines.node` is `>=20`. |
| **Git 2.40 or newer** | Workspace creation uses `git check-attr --source`, which Git 2.40 introduced. On older Git, workspace creation fails closed with `git_operation_failed`. |
| **Git for partial clones** | For repositories cloned with `--filter` (promisor remotes), Git must honor `GIT_NO_LAZY_FETCH`: 2.45.1 or newer, or a patched maintenance release (2.40.2, 2.41.1, 2.42.2, 2.43.4, 2.44.1 and later patches of those series). Other versions are rejected with `invalid_repository`. Ordinary clones have no extra requirement. |
| **A Git repository with at least one commit** | v1 works only with Git repositories. Bare repositories and repositories without a `HEAD` commit are rejected. |
| **No external Git filter drivers** | If a tracked or selected path uses an external filter (`filter.<driver>.clean` / `smudge` / `process`, for example Git LFS), the repository is rejected (`invalid_repository`). Built-in `text` / `eol` normalization is fine. |
| **The Splash engine, running** | See [Quick start](#quick-start). Model and hardware requirements are documented in the [engine repository](https://github.com/incoai/splash). |

## Quick start

### 1. Install and start the Splash engine

```sh
brew install incoai/tap/splash
splash serve --model incoai/Qwen3.8-27B-Splash
```

`splash serve` runs in the foreground (Ctrl+C stops it), so keep it running in its own terminal. By default it listens on `http://127.0.0.1:8000`, which is also Splash MCP's default backend URL. The model id matches Splash MCP's default `SPLASH_BACKEND_MODEL`, so no configuration is needed.

Optional check:

```sh
curl -s http://127.0.0.1:8000/status
curl -s http://127.0.0.1:8000/v1/models
```

Splash MCP requires `/status` to report `"ready": true` and a positive `maximum_context_tokens`. It also requires `/v1/models` to list the configured model id exactly.

### 2. Build Splash MCP

```sh
git clone https://github.com/gucluceyhan/MCP.git splash-mcp
cd splash-mcp
npm ci
npm run build
```

This produces `dist/index.js`, the server entry point. Optional smoke test: `node dist/index.js` should print `[splash] splash v0.1.0 running on stdio` to stderr and then wait for MCP messages on stdin. Press Ctrl+C to exit.

### 3. Register it with Claude Code

```sh
claude mcp add splash --scope user -- node /absolute/path/to/splash-mcp/dist/index.js
```

- Use the absolute path to `dist/index.js`.
- To pass configuration, add `-e` flags before `--`, for example:

  ```sh
  claude mcp add splash --scope user -e SPLASH_MAX_ROUNDS=5 -- node /absolute/path/to/splash-mcp/dist/index.js
  ```

- To remove it later:

  ```sh
  claude mcp remove splash -s user
  ```

Splash works on the Git repository that contains the server process's working directory. It walks up to the Git toplevel. Start Claude Code inside the repository you want to work on, or pin a repository with `SPLASH_REPO_ROOT`.

### 4. Delegate a task

Start a **new** Claude Code session inside a Git repository. Registered tools appear only in new sessions. The four tools `splash_task`, `splash_refine`, `splash_diff` and `splash_close` should now be available (`/mcp` shows connected servers).

Splash MCP ships no server-level instructions. The orchestrator learns the workflow from the tool descriptions, so it helps to state the workflow in your prompt. For example:

```text
Use splash_task to add a --dry-run flag to the CLI in src/cli.ts and cover it in
test/cli.test.ts. Editable files: src/cli.ts, test/cli.test.ts.
Review the compact result; call splash_diff only if you need to see the code.
If changes are needed, use splash_refine with concrete feedback.
When it is correct, call splash_close and apply the patch with git apply,
but only if base_status is "fresh".
```

Note: the root `CLAUDE.md` / `AGENTS.md` are also sent to the local worker as project rules (see [Project rules](#project-rules)). Keep orchestrator-only instructions in your prompt rather than in those files.

### 5. Apply the result

`splash_close` returns an absolute `patch_path`. If `base_status` is `"fresh"`, apply the patch from the repository root:

```sh
git apply --check /Users/you/.splash/patches/<repo-id>/<session-id>.patch
git apply /Users/you/.splash/patches/<repo-id>/<session-id>.patch
```

If `base_status` is `"stale"`, do **not** apply the patch automatically. See [Stale base](#stale-base).

### Codex CLI

Recent Codex CLI versions read MCP servers from `~/.codex/config.toml`:

```toml
[mcp_servers.splash]
command = "node"
args = ["/absolute/path/to/splash-mcp/dist/index.js"]
```

Splash adds nothing specific to Codex. Codex uses the same four tools through standard MCP. If your client does not start the server inside the project directory, set `SPLASH_REPO_ROOT` through the client's mechanism for MCP server environment variables.

## How it works

### Architecture

```text
Orchestrator (Claude Code / Codex)
   |  splash_task(task, files)                         ^ compact JSON result
   v                                                   | (no generated code)
Splash MCP --reads selected files (read-only)--> your repository working tree
   |  redacted, exactly measured context
   v
Local model via the Splash engine  (no shell, no git, no filesystem)
   |  returns a JSON patch: modify (exact search/replace) | create | delete
   v
Splash MCP --validates, then applies--> isolated git worktree
                                        <outputRoot>/sessions/<session-id>/workspace
```

### The review loop

```text
splash_task(task, files)  ->  compact result (status, summary, files_changed, diff_stats)
   |
   |-- need changes?   splash_refine(session_id, feedback[, files])  ->  compact result (repeat)
   |-- want the code?  splash_diff(session_id[, files][, stat])      ->  unified diff / stats
   '-- accept          splash_close(session_id)                      ->  patch_path, base_status
                           |
                           |-- base_status "fresh"  ->  git apply <patch_path>
                           '-- base_status "stale"  ->  do not auto-apply; inspect and decide
```

Each round, the frontier reads the task it already wrote and a compact result. It reads a diff only if it asks for one. Generating the code happens locally. A small, obviously correct result can be accepted from `summary`, `files_changed` and `diff_stats` alone.

### Base capture and the worktree

When `splash_task` creates a session, Splash builds a Git worktree with a detached base commit. The base contains:

- `HEAD`,
- your exact uncommitted tracked changes, staged and unstaged (`git diff HEAD --binary --full-index`),
- the untracked files you selected.

The base commit is made with hooks disabled, signing off, and a fixed Splash identity, and no branch or tag is created. The base is **immutable** for the life of the session. The worker always edits against it, and every refine round resets the worktree to it before applying the worker's full revised patch set. Patches never drift between rounds.

Git itself still records the worktree under the repository's `.git/worktrees/` and stores the transient base commit's objects in the shared object database. `splash_close` removes the worktree. The base commit is not referenced by any branch or tag.

### What the worker sees

- The task text and the latest feedback.
- The **editable** files listed in `splash_task`'s `files`, complete and never truncated.
- Optional **read-only reference** files added through `splash_refine`'s `files`. These are read fresh from your working tree, labeled read-only, and the worker cannot edit them.
- The pinned project rules.
- Refinement history, including the previous validation verdict, so the worker can see why an edit was rejected.

Everything is redacted before measurement and dispatch.

### Project rules

Rules are resolved once, when the session is created:

1. If the caller passes a non-blank `options.rules` string, it is used and the repository is not consulted (`rules_source: "hook"`).
2. Otherwise Splash reads `CLAUDE.md` and then `AGENTS.md` from the repository root only. There is no crawling. If both exist they are combined, `CLAUDE.md` first. A root `AGENTS.md` that is a symlink to the root `CLAUDE.md` is treated as an alias and skipped. Any other symlink, a non-regular file, invalid UTF-8 or a read error fails the request with `rules_resolution_failed`.
3. If neither source yields rules, the session proceeds without rules (`rules_source: "none"`).

Rules have a soft budget of 8,192 tokens (configurable). Over budget, only exact duplicates are compacted. If the rules are still over budget after that, a fixed warning is reported. Unique rule material is never dropped silently.

### Adaptive context budget

Splash measures every prompt exactly with the runtime's tokenizer endpoints, not with character heuristics. It then picks the smallest context tier that fits:

- The tiers are 64K, 128K and 192K, plus `runtime_max`, the `maximum_context_tokens` that the runtime reports in `/status`.
- Splash reserves output headroom: 32,768 tokens minimum, 65,536 preferred when it fits the selected tier.
- Editable files are never truncated.
- If the full context does not fit, Splash reduces it in this order: old refinement history, then old worker responses, then read-only reference files (whole files).
- If the editable files plus the minimum output reserve cannot fit at all, nothing is sent to the model, and the result is `status: "needs_split"` with a `split_hint`.

### Stale base

Before every `splash_refine` and at `splash_close`, Splash compares the live editable files in your working tree against the fingerprints captured at session start: existence, type, mode and content. It also flags any path the worker created that has since appeared in your working tree.

- **On refine:** the round is aborted before the model is called. The result has `status: "stale_base"` and `stale_files`, and the session stays open. You can restore the drifted files to their base state and refine again, or close the session and start a new task from the current state.
- **On close:** staleness never blocks the close. The patch is exported with `base_status: "stale"`. Treat that as "export succeeded, automatic apply is unsafe". Inspect the patch, apply the compatible parts manually (for example with `git apply --3way`), or start a new task.

### Sessions and persistence

- Sessions are persisted under `<outputRoot>/sessions/<session-id>/`. The directory is mode 0700 and `session.json` is mode 0600.
- A server restart does not lose open sessions. The next call that uses a `session_id` recovers the session, either by reusing a surviving worktree that still matches or by recreating it from the persisted base and the latest validated patch. Stale checks still apply after recovery.
- Every session that returned a `session_id` holds a Git worktree until `splash_close` is called. This includes sessions whose first result was `needs_split` or `inference_busy`. Splash has no list tool. Open sessions are the directories under `<outputRoot>/sessions/`, and their worktrees appear in `git worktree list`.
- After a successful close, the session's state is removed. Only the exported patch remains, and any further call with that id returns `session_not_found`.

### Inference coordination

- Within one Splash MCP process, inference requests from all sessions go through a single FIFO queue. A request that is waiting simply returns its normal result when its turn comes.
- Across processes, Splash coordinates through a lock under `<outputRoot>/runtime/`. If another Splash MCP process that shares the same output root is generating, the call returns `inference_busy` immediately with `conflict: "splash"`.
- Before measuring and again before dispatching, Splash scans the host for competing runtimes: another Splash engine process, `mlx_lm` / `mlx_vlm`, or `ollama serve` / `ollama runner`. The configured engine's own process tree is excluded from the scan. Splash identifies the engine by the PID it reports in `/status`. When it detects a conflict, it returns `inference_busy` immediately. Nothing is queued in the background, nothing runs later, and the session is preserved.

### Where files are stored

```text
<outputRoot>/                                  default: ~/.splash
|-- patches/<repo-id>/<session-id>.patch       exported patches (kept after close)
|-- sessions/<session-id>/
|   |-- session.json                           persisted session state
|   '-- workspace/                             the session's git worktree
'-- runtime/                                   inference lock and state
```

`<repo-id>` is the first 16 hex characters of the SHA-256 of the canonical repository root path. `<session-id>` is a random UUID. The output root must be outside the repository, or tasks fail with `output_root_unsafe`.

## Tool reference

### Conventions

- Every tool returns one text content item.
- `splash_task`, `splash_refine` and `splash_close` return a JSON object. `splash_diff` returns raw diff text, or JSON when `stat: true`.
- On failure, a tool returns `isError: true` and a JSON body:

  ```json
  { "kind": "session_not_found", "message": "The session was not found" }
  ```

  `status` (an HTTP status code) is added only for `kind: "http"`. See [Errors and troubleshooting](#errors-and-troubleshooting) for all kinds.
- Paths are repository-relative to the project root (the Git toplevel). They are literal paths: no globs and no directories. Paths that escape the repository, absolute paths, and paths into `.git` are rejected.
- `splash_diff` and `splash_close` reject unknown input fields. `splash_task`'s `options` object also rejects unknown keys.

### `splash_task`

Starts a session and runs the first round.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `task` | string | yes | What to implement. Must be non-empty after trimming. Redacted before it reaches the worker. |
| `files` | string[] | yes | The **editable base**. These are the only existing files the worker may modify or delete; the worker may also create new files. May be `[]` for create-only tasks. May name files that do not exist yet. |
| `options` | object | no | Per-session overrides. They are pinned for the whole session and cannot be changed on refine. |
| `options.reasoning_effort` | `"none"`, `"low"`, `"medium"`, `"xhigh"` | no | Forwarded to the backend as `reasoning_effort` only when set. |
| `options.context_tier` | `"64k"`, `"128k"`, `"192k"`, `"runtime_max"` | no | Forces a context tier instead of adaptive selection. A tier above the runtime maximum is `invalid_input`. |
| `options.output_reserve_tokens` | positive integer | no | Forces the output reserve. Must be at least `SPLASH_CONTEXT_MIN_OUTPUT_RESERVE`. |
| `options.rules` | string | no | Project rules supplied by the caller (`rules_source: "hook"`). A blank value falls back to `CLAUDE.md` / `AGENTS.md`. |

Example input:

```json
{
  "task": "Add a --dry-run flag to the CLI that prints the planned actions without executing them.",
  "files": ["src/cli.ts", "test/cli.test.ts"]
}
```

Returns a [compact result](#compact-result). `splash_task` always reports `base_status: "fresh"`. If an operational error occurs during the first round (for example the backend is unreachable), the session and its worktree are removed, and the call returns an error without a `session_id`.

### `splash_refine`

Runs another round in an open session, with correction feedback.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | string | yes | Session to refine. |
| `feedback` | string | yes | Concrete correction for the worker. Must be non-empty after trimming. The original task stays in force; feedback does not replace it. |
| `files` | string[] | no | Additional **read-only** reference files. They accumulate across rounds and never become editable; paths that are already editable are ignored. To make another file editable, start a new session. |

Example input:

```json
{
  "session_id": "3f6c1e2a-8b4d-4c7e-9a51-2d0f7b6e4c10",
  "feedback": "src/cli.ts: --dry-run must also skip the network call in upload(). Keep the existing option order.",
  "files": ["src/upload.ts"]
}
```

Returns a [compact result](#compact-result) of the same shape. Notes:

- The stale-base check runs first; if it fails, the result is `stale_base` and no inference runs.
- The worker produces a complete revised patch set against the immutable base. It replaces the previous round's patch; it is not applied on top of it.
- If a refine round fails with an error, the session is preserved in its previous state.
- `splash_refine` on a session whose first result was `needs_split` or `inference_busy` runs that first generation.

### `splash_diff`

Returns the generated changes of an open session. This is the only tool that returns generated code.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | string | yes | Open session to inspect. |
| `files` | string[] | no | Restrict the diff to these literal repository-relative paths. |
| `stat` | boolean | no | If `true`, return statistics only, with no source. |

- **Default:** the unified diff of the whole session worktree against its immutable base, with 3 lines of context, as raw text. Returns an empty string if nothing changed.
- **`stat: true`:**

  ```json
  { "diff_stats": { "files": 2, "insertions": 34, "deletions": 3 } }
  ```

`splash_diff` runs no inference, does not change persisted state, and is not blocked by a stale base. It works only before `splash_close`. Before diffing, Splash verifies the worktree against the last committed round. Direct edits made inside the worktree are discarded; use `splash_refine` for changes.

### `splash_close`

Exports the final patch and closes the session.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | string | yes | Session to close. |

Output:

| Field | Description |
|-------|-------------|
| `patch_path` | Absolute path of the exported patch: `<outputRoot>/patches/<repo-id>/<session-id>.patch`. Splash always derives it; the caller cannot choose it. |
| `files_changed` | Changed paths of the latest generated round (`[]` if nothing was generated). |
| `diff_stats` | `{ files, insertions, deletions }`, measured from the worktree just before export. |
| `summary` | The latest compact summary. |
| `base_status` | `"fresh"` or `"stale"`. |
| `stale_files` | Present only when `base_status` is `"stale"`. |

Example (fresh):

```json
{
  "patch_path": "/Users/you/.splash/patches/1a2b3c4d5e6f7a8b/3f6c1e2a-8b4d-4c7e-9a51-2d0f7b6e4c10.patch",
  "files_changed": ["src/cli.ts", "test/cli.test.ts"],
  "diff_stats": { "files": 2, "insertions": 34, "deletions": 3 },
  "summary": "Added a --dry-run flag that lists planned actions and skips execution; added two tests.",
  "base_status": "fresh"
}
```

Example (stale):

```json
{
  "patch_path": "/Users/you/.splash/patches/1a2b3c4d5e6f7a8b/3f6c1e2a-8b4d-4c7e-9a51-2d0f7b6e4c10.patch",
  "files_changed": ["src/cli.ts", "test/cli.test.ts"],
  "diff_stats": { "files": 2, "insertions": 34, "deletions": 3 },
  "summary": "Added a --dry-run flag that lists planned actions and skips execution; added two tests.",
  "base_status": "stale",
  "stale_files": ["src/cli.ts"]
}
```

Behavior:

- **What the patch contains.** The exported patch is the complete `git diff --binary --full-index` of the worktree against the base: modifications, deletions, new files and supported binary changes. It contains only the task's contribution, not your pre-existing uncommitted changes.
- **Stale base.** A stale base never blocks the close. The patch is still exported, but it must not be applied automatically.
- **No inference.** Close never calls the model. Sessions that reached `max_rounds` close normally. A session that never generated anything exports an empty patch with 0/0/0 stats.
- **When something fails.** If the export fails, nothing is deleted, so you can retry the close. In general, operational failures during close keep the persisted session so it can be recovered. Only staleness is guaranteed not to block the close.
- **After a successful close.** The worktree and session state are removed and the patch file stays on disk. Splash never applies it.

### Compact result

Returned by `splash_task` and `splash_refine`. It never contains source code, diff text or rules content. `summary` is the worker's own short text, or a fixed message for statuses where nothing was generated.

```json
{
  "session_id": "3f6c1e2a-8b4d-4c7e-9a51-2d0f7b6e4c10",
  "round": 1,
  "status": "applied",
  "base_status": "fresh",
  "rules_source": "CLAUDE.md",
  "context": {
    "runtime_max_tokens": 262144,
    "input_tokens": 18342,
    "output_reserve_tokens": 32768,
    "selected_context_tier": "64k",
    "truncated_readonly_context": false
  },
  "summary": "Added a --dry-run flag that lists planned actions and skips execution; added two tests.",
  "files_changed": ["src/cli.ts", "test/cli.test.ts"],
  "diff_stats": { "files": 2, "insertions": 34, "deletions": 3 },
  "validation": { "edits_requested": 2, "edits_applied": 2, "rejected": [] },
  "warnings": [],
  "usage": { "in": 18342, "out": 1210 }
}
```

The numbers above are illustrative.

| Field | Description |
|-------|-------------|
| `session_id` | Opaque session id. |
| `round` | The round this call represents. `splash_task` is round 1. For statuses where nothing was generated, it is the round that was attempted. |
| `status` | See [Status values](#status-values). |
| `base_status` | `"fresh"` or `"stale"`. |
| `stale_files` | Drifted paths. Present only when `base_status` is `"stale"`. |
| `rules_source` | `"hook"`, `"CLAUDE.md"`, `"AGENTS.md"`, `"CLAUDE.md + AGENTS.md"` or `"none"`. |
| `context.runtime_max_tokens` | `maximum_context_tokens` reported by the runtime. |
| `context.input_tokens` | Exact token count of the dispatched prompt. `0` when no prompt was dispatched. |
| `context.output_reserve_tokens` | Output headroom reserved for the worker. |
| `context.selected_context_tier` | `"64k"`, `"128k"`, `"192k"` or `"runtime_max"`. |
| `context.truncated_readonly_context` | `true` if read-only reference files were dropped to fit the budget. |
| `summary` | Short summary, assumptions and open questions from the worker, or a fixed status message. |
| `files_changed` | Changed paths of the current (or last successful) round. |
| `diff_stats` | `{ files, insertions, deletions }`. |
| `validation.edits_requested` / `edits_applied` | Edit counts for the round. |
| `validation.rejected[]` | `{ file, edit, reason }`. `edit` is the zero-based index of the edit in the worker's patch. |
| `warnings` | Fixed, content-free warnings, for example an omitted secret file or rules over budget. |
| `usage` | `{ in, out }` token usage reported by the backend. |
| `split_hint` | Present only for `needs_split`: `required_input_tokens`, `available_max_tokens`, `output_reserve_tokens`, `pressure_files` (up to 8 of the largest editable files), and optionally `suggested_groups` (not populated by the current version). |
| `inference` | Present only for `inference_busy`: `{ "conflict": "splash" \| "mlx" \| "ollama" \| "unknown" }`. |

Rejection reasons in `validation.rejected[].reason` come from a fixed vocabulary:

- `path not editable`
- `read-only path`
- `unsafe path`
- `target missing`
- `target is not a regular text file`
- `target is not a file`
- `create target already exists`
- `target conflicts with another edit`
- `unsafe symlink traversal`
- `overlapping edits`
- `edit contains a redaction placeholder`
- `path is ignored`
- `search text not found at operation <n>`
- `match not unique at operation <n>`

### Status values

| Status | Model called? | Meaning | Typical next step |
|--------|---------------|---------|-------------------|
| `applied` | yes | All edits validated and applied. A valid empty patch also counts. | Review; `splash_close` or `splash_refine`. |
| `partial` | yes | Some edits applied, some rejected (see `validation.rejected`). | `splash_refine` with feedback. |
| `failed` | yes | Every edit was rejected. This is a normal result, not a tool error. | `splash_refine` with feedback. |
| `stale_base` | no | A base file drifted in your working tree. Nothing was run. | Restore the drift and refine, or `splash_close` and start a new task. |
| `needs_split` | no | The editable files plus the minimum output reserve do not fit the runtime's context window. | `splash_close` (empty patch), then delegate smaller tasks. |
| `max_rounds` | no | The `SPLASH_MAX_ROUNDS` guardrail was reached. The session is preserved. | Call `splash_refine` again to continue on purpose, or inspect / close. |
| `inference_busy` | no | A competing local runtime or another Splash process holds the inference resource. The session is preserved. | Retry later with `splash_refine`, or close. |

## Configuration

Splash MCP is configured only through environment variables. Values are trimmed, and an empty value means "use the default". If any value is invalid, the server refuses to start and prints `[splash] fatal: <reason>` to stderr. The message never contains the raw value.

| Variable | Default | Description |
|----------|---------|-------------|
| `SPLASH_BACKEND_BASE_URL` | `http://127.0.0.1:8000` | Origin of the inference runtime. Must be `http://` or `https://` and a bare server origin: no path prefix, query string, fragment or embedded `user:pass@`. |
| `SPLASH_BACKEND_MODEL` | `incoai/Qwen3.8-27B-Splash` | Model id. Must exactly match an id listed by `/v1/models`. |
| `SPLASH_API_KEY` | unset | Optional bearer token, sent as `Authorization: Bearer <key>`. Visible ASCII only. Never logged and never included in errors. |
| `SPLASH_REPO_ROOT` | unset | Pins the project. Without it, the repository is discovered from the server's working directory. `~` is expanded. The path must exist; Git's own upward discovery is applied to it. |
| `SPLASH_OUTPUT_ROOT` | `~/.splash` | Root for patches, sessions and the runtime lock. Must be outside the repository. `~` is expanded. |
| `SPLASH_MAX_ROUNDS` | `10` | Refinement guardrail (positive integer). See `max_rounds`. |
| `SPLASH_CONTEXT_TIERS` | `65536,131072,196608` | Comma-separated, strictly increasing subset of `65536`, `131072`, `196608`. `runtime_max` always comes from the runtime and is never configured. |
| `SPLASH_CONTEXT_MIN_OUTPUT_RESERVE` | `32768` | Minimum output headroom in tokens. |
| `SPLASH_CONTEXT_PREFERRED_OUTPUT_RESERVE` | `65536` | Preferred output headroom, used when it fits the selected tier. Must not be below the minimum. |
| `SPLASH_CONTEXT_RULES_SOFT_BUDGET` | `8192` | Soft token budget for project rules. |

Integer variables must be plain positive decimal integers. There is no configuration file.

## Safety model

Splash is a **local developer tool** that runs under your own OS account. Its goal is to make a local model useful for implementation work while keeping that model fully outside your repository and keeping generated code out of the frontier context unless the orchestrator asks for it.

**What Splash enforces**

- The worker has no tools. It emits JSON text, and Splash parses that text strictly and decides what happens.
- Every write happens inside the session worktree or the patch file under the output root. Splash never applies a patch to your repository.
- Validation happens before any write: the editable allow-list, path bounds, unique exact matches against the immutable base, and rejection of overlapping edits.
- All paths go through one path-safety check. Traversal (`..`), absolute paths, backslash and NUL paths, and `.git` (any case) are rejected. Symlinks must resolve inside the repository. Content is read with no-follow semantics.
- Git commands run without a shell and with repository hooks and `core.fsmonitor` disabled. Repository-local environment variables such as `GIT_DIR` and `GIT_WORK_TREE` are stripped, and lazy promisor fetches are disabled. Pathspecs are pinned as `:(literal)`.
- Repositories that use external Git filter drivers are rejected. The check is repeated every round, because the worker could write a `.gitattributes` file.
- Before anything goes to the model, Splash applies two protections:
  - It redacts private-key and certificate blocks, common token formats (`sk-…`, `AKIA…`, GitHub, Slack, Google API keys, JWTs), bearer tokens, credentials in URLs, credential assignments (`password=…`, `api_key: …`), email addresses and phone numbers.
  - It replaces the entire content of secret files with a placeholder. These include `.env` and `.env.<suffix>` (except `example`, `sample`, `template`, `dist`), `*.pem`, `*.key`, `*.crt`, `*.p12`, SSH private keys, `credentials*`, `.npmrc`, `.netrc` and similar files.
- MCP responses contain only metadata, except `splash_diff`. Errors carry only a `kind` and a short, safe message.
- Session directories are mode 0700 and session files 0600.

**What Splash does not guarantee**

- **Redaction is pattern-based.** It is deterministic pattern matching plus file-name classification. It cannot recognize every secret. Only select files you are willing to send to the local model.
- **Splash does not review the code.** Validation is structural only. Splash runs no tests or linters, and the orchestrator remains the reviewer.
- **Prompts go wherever the backend URL points.** Splash sends the selected, redacted context to `SPLASH_BACKEND_BASE_URL`. Keep it on localhost unless you intend otherwise.
- **The runtime check is a snapshot.** Splash checks for competing runtimes before each dispatch, but it cannot stop you from starting another runtime afterwards.
- **Same-user processes are out of scope.** The threat model does not cover a malicious process running as the same OS user that actively tampers with Splash's directories while they are being used. See the accepted threat model in [DESIGN.md](DESIGN.md).

## Errors and troubleshooting

### Error kinds

| `kind` | Meaning |
|--------|---------|
| `invalid_input` | An argument violates the tool contract. Examples: empty `task`/`feedback`, unsafe path, malformed `session_id`, `context_tier` above the runtime maximum, `output_reserve_tokens` below the minimum. |
| `invalid_repository` | The repository cannot be used. Causes: not a Git working tree, no `HEAD` commit, `SPLASH_REPO_ROOT` does not exist, an external Git filter (for example LFS), an unsupported partial-clone Git version, or an editable path whose existence or type in your working tree differs from what Git checked out (for example a sparse checkout). |
| `unsafe_path` | A path escapes the repository, targets `.git`, or passes through an unsafe symlink. |
| `git_operation_failed` | A Git command failed (for example on a Git release without `check-attr --source`). |
| `workspace_operation_failed` | A worktree lifecycle step failed. For example, your working tree changed while the base was being captured. |
| `export_failed` | The patch could not be written. The session and worktree are kept; retry `splash_close`. |
| `workspace_destroyed` | The operation targeted a worktree that had already been destroyed. |
| `output_root_unsafe` | `SPLASH_OUTPUT_ROOT` is inside the repository. |
| `rules_resolution_failed` | The root `CLAUDE.md` / `AGENTS.md` could not be read safely. |
| `assembly_failed` | The context could not be assembled safely because of an I/O or measurement failure. |
| `network` | The runtime could not be reached, the request timed out, or it was aborted. |
| `http` | The runtime answered with a non-2xx status (see `status`). |
| `invalid_status` | `/status` reports not ready or an invalid `maximum_context_tokens`, or `/v1/models` is malformed. |
| `model_mismatch` | `SPLASH_BACKEND_MODEL` is not served by the runtime. |
| `invalid_response` | The runtime returned 2xx with an unexpected body. |
| `invalid_request` | An internal request failed validation. |
| `output_truncated` | Generation hit the output limit (`finish_reason: "length"`). |
| `invalid_output` | The model's reply was not a valid Splash patch document. |
| `aborted` | The request was cancelled before inference started. |
| `lock_release_failed` | The inference lock under `<outputRoot>/runtime/` could not be released. |
| `session_not_found` | The `session_id` is unknown or the session was already closed. |
| `session_corrupt` | The persisted session state failed validation. |
| `session_persistence_failed` | Session state could not be written. |
| `session_recovery_failed` | The worktree could not be recovered or verified against the last committed round. |
| `session_operation_failed` | Generic safe session failure. |
| `session_conflict` | Session id collision. |
| `task_cleanup_failed` | Cleaning up a worktree or session directory failed. |
| `shutting_down` | The server is shutting down and no new work is accepted. |
| `internal_error` | Unexpected error; no details are exposed. |

### Common situations

**The tools do not appear in Claude Code.**
1. Tools appear only in new sessions, so start one.
2. Make sure `npm run build` succeeded and the registered path is absolute and points to `dist/index.js`.
3. Run `node /absolute/path/to/splash-mcp/dist/index.js` manually. It should print `[splash] splash v0.1.0 running on stdio`. A `[splash] fatal: Invalid SPLASH_...` line means a configuration value is invalid.

**The backend is not running.** `splash_task` returns:

```json
{ "kind": "network", "message": "Could not reach the inference runtime (/status)" }
```

No session is created. Start `splash serve` and retry. If the engine is up but not ready, you get `invalid_status`. If it serves a different model, you get `model_mismatch`.

**`inference_busy`.** This is a status, not an error. Nothing ran and nothing was lost. `inference.conflict` tells you why:

| `conflict` | Cause |
|------------|-------|
| `splash` | Another Splash MCP process using the same output root is generating, or a Splash engine other than the configured one is running. |
| `mlx` | An `mlx_lm` / `mlx_vlm` process is running. |
| `ollama` | `ollama serve` or `ollama runner` is running. |
| `unknown` | The lock state could not be verified, the runtime did not report its PID in `/status`, or the process scan failed. |

Stop the competing runtime, or wait. Then retry with `splash_refine` on the same session (feedback is required, for example "Retry the task."), or close the session.

**Stale base.** Your working tree changed the editable files after the session started. Restore them and refine again, or `splash_close` and start a new task. Never auto-apply a stale patch.

**`needs_split`.** The editable files are too large for the runtime's context window plus the minimum output reserve. Nothing was sent to the model. Close the session (it exports an empty patch), then delegate smaller tasks with fewer editable files. `split_hint.pressure_files` names the largest files.

**`max_rounds`.** After `SPLASH_MAX_ROUNDS` generated rounds, the next `splash_refine` returns `max_rounds` without running the model. Calling `splash_refine` again continues explicitly. The acknowledgement survives restarts.

**`invalid_output` or `output_truncated`.** The model's reply was unusable. On `splash_task` no session is created; on `splash_refine` the session keeps its previous state. Retry or simplify the task. For truncation you can also raise `options.output_reserve_tokens`, but only on a new `splash_task`, because options are pinned per session.

**`output_root_unsafe`.** Move `SPLASH_OUTPUT_ROOT` outside the repository.

**Line endings and file modes when applying.** The exported patch is in Git's normalized form. In a checkout with `text=auto` and CRLF line endings, `git apply` may rewrite touched files in the checkout's line endings, so review line endings before committing. With `core.fileMode=false`, Git older than 2.44 may write mode 100644 when it applies a patch.

## Limitations

- **Experimental.** v0.1.0 has not yet been validated end to end against a real local model.
- **One backend type.** v1 supports only an OpenAI-compatible HTTP backend, and it relies on the Splash engine's API (`/status` with `ready`, `maximum_context_tokens` and `instance.pid`, plus `/v1/models`, `/tokenize`, `/apply-template` and `/v1/chat/completions`). There is no Ollama backend in v1.
- **One platform.** The Splash engine requires Apple Silicon macOS.
- **Git repositories only.** External filter drivers (including Git LFS) are not supported.
- **stdio transport only.** There is no HTTP/SSE transport.
- **One generation at a time.** There is no parallel local inference.
- **No automatic rebase or merge.** A stale base is reported and left to the orchestrator.
- **Fixed editable set.** Files can become editable only at session start; refine adds read-only references.
- **No test or lint execution.** Splash does not run checks inside the worktree.
- **No session management tools.** There is no list tool and no automatic cleanup of abandoned sessions.

Open topics are tracked in [issue #35](https://github.com/gucluceyhan/MCP/issues/35).

## Development

```sh
npm ci
npm run build       # compile src/ to dist/
npm run typecheck   # type-check sources and tests (also rebuilds dist/)
npm test            # build, compile tests to dist-test/, run node --test
```

Source layout:

```text
src/
|-- index.ts        entry point: config, runtime, stdio transport
|-- server.ts       MCP tool registration and input schemas
|-- config.ts       environment configuration and defaults
|-- backend/        OpenAI-compatible backend, inference coordinator, runtime lock, conflict detector
|-- context/        context assembly, adaptive budget, redaction
|-- rules/          project rules resolution
|-- session/        session lifecycle, persistence, stale check, rounds
|-- task/           task service, wire serialization, task errors
|-- worker/         worker prompt contract and result schema
'-- workspace/      git worktree workspace, git execution, path safety, validation
```

The full architecture, security model and tool contracts are in [DESIGN.md](DESIGN.md).

## License

See [LICENSE](LICENSE).
