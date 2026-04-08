# Copilot Instructions — obsidian-copilot

## Project overview

Obsidian plugin (TypeScript/Electron) that embeds GitHub Copilot as an agentic chat panel. Uses the `@github/copilot-sdk` (technical preview) to spawn the Copilot CLI as a JSON-RPC subprocess. Desktop only.

**Stack:** TypeScript 4.7 · esbuild · Obsidian Plugin API · Node.js 18+ · Copilot SDK

## Architecture

```
CopilotPlugin (main.ts)          – Plugin lifecycle, commands, settings, lastActiveMarkdownView tracking
├── CopilotClientManager         – SDK bridge: connect, send, reconnect (exponential backoff), heartbeat
│   └── @github/copilot-sdk      – JSON-RPC ↔ Copilot CLI subprocess ↔ LLM + tools
├── CopilotChatView              – ItemView: chat UI, streaming, markdown rendering, agent dropdown
├── CopilotSettingTab            – PluginSettingTab: settings form, custom agent CRUD
├── tools.ts                     – 7 vault tools (read/search/create/append/metadata)
└── types.ts                     – Interfaces, defaults, constants (COPILOT_VIEW_TYPE, AVAILABLE_MODELS)
```

Key data flow: User input → CopilotChatView.handleSend → CopilotClientManager.sendMessage → SDK session → CLI subprocess → LLM. Tool calls (e.g. `read_active_note`) route back through tools.ts handlers → Obsidian vault API.

## Build & run

```bash
npm install              # install deps (includes @github/copilot-sdk)
npm run dev              # esbuild watch mode → main.js (with inline sourcemaps)
npm run build            # tsc --noEmit --skipLibCheck && esbuild production
```

Output: `main.js` (CJS bundle), `styles.css`, `manifest.json` — copy all three to `<vault>/.obsidian/plugins/obsidian-copilot/`.

No test suite exists. Validate manually in Obsidian (Developer Tools: Ctrl+Shift+I / Cmd+Opt+I).

## Conventions

- **Format:** CJS output required by Obsidian plugin loader. esbuild bundles all deps except `obsidian`, `electron`, `@codemirror/*`, `@lezer/*`, and Node builtins.
- **Externals:** Never import from `obsidian` at runtime in a way that requires bundling it. It's provided by the host.
- **Types:** `any` is used intentionally for SDK types (`CopilotClientInstance`, `CopilotSessionInstance`) because the SDK ships no public type declarations. Don't replace with `unknown` unless the SDK ships types.
- **PATH resolution:** Obsidian/Electron doesn't inherit the user's shell PATH. `resolveShellEnv()` and `resolveCLIPath()` capture the login-shell environment. Don't simplify these — they handle NVM, Homebrew, and non-standard setups.
- **Event cleanup:** Streaming uses `session.on()` with explicit `unsub` calls on `session.idle` / `session.error`. Always unsubscribe all three listeners (delta, idle, error) together to prevent stacking.
- **Tool handlers:** Return `{ error: string }` on failure. Never throw — the SDK won't catch it.
- **Active view tracking:** `lastActiveMarkdownView` in main.ts tracks the most recent MarkdownView before focus moves to the chat panel. Tools use `resolveActiveView()` which falls back through: tracked → activeLeaf → leavesOfType. Don't change this chain without testing.
- **CSS:** Uses Obsidian CSS variables (`--background-primary`, etc.) for theme compatibility. No hardcoded colors.
- **Settings persistence:** Call `this.plugin.saveSettings()` after every setting mutation.
- **Custom agents:** Stored in settings as `CustomAgent[]`. Agent names are auto-slugified (lowercase, hyphens). The `@agentName` prefix is prepended to prompts, not stored in message history.

## Known issues & pitfalls

- **tsconfig deprecations:** `baseUrl` and `moduleResolution: "node"` are deprecated in TS 7.0. Build works because `--skipLibCheck` is used. If upgrading TS, add `"ignoreDeprecations": "6.0"` or migrate.
- **No streaming timeout:** If `session.idle` / `session.error` never fire, listeners leak. No client-side send timeout exists.
- **search_vault performance:** Sequential `cachedRead()` over all markdown files. Slow on vaults with 10k+ notes.
- **CLI path errors:** If resolution fails, the SDK surfaces a generic error. The `formatConnectionError()` method maps common patterns but can't cover all NVM/shell edge cases.
- **SDK breaking changes:** `@github/copilot-sdk@^0.1.32` is technical preview. Pin version carefully on upgrade.

## File reference

| File | Purpose |
|------|---------|
| `main.ts` | Plugin entry: lifecycle, commands, icon registration |
| `CopilotClient.ts` | SDK connection manager, reconnect logic, shell env resolution |
| `CopilotChatView.ts` | Chat UI (ItemView): messages, streaming, agent selector, pills |
| `CopilotSettingTab.ts` | Settings panel: CLI path, model, agents, appearance |
| `tools.ts` | Vault tool definitions and handlers |
| `types.ts` | Interfaces, defaults, model list, view type constant |
| `esbuild.config.mjs` | Bundle config: CJS, externals, watch/production modes |
| `styles.css` | All plugin CSS, Obsidian theme variables |
| `manifest.json` | Obsidian plugin manifest (id, version, minAppVersion) |
