import { Notice } from "obsidian";
// @ts-ignore – esbuild will bundle this ESM package into the CJS output
import { CopilotClient as CopilotClientSDK, defineTool, approveAll } from "@github/copilot-sdk";
import { execSync, execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import type { CopilotPluginSettings, ChatMessage } from "./types";

export type ConnectionState = "connected" | "reconnecting" | "failed";

// ─── Resolve the copilot CLI to a full absolute path ─────────────────────────
// Obsidian on macOS doesn't inherit the user's shell PATH (especially NVM),
// so bare command names like "copilot" fail existsSync and spawn.
// We run `which` through a login shell so it picks up ~/.zshrc / ~/.bashrc.
function resolveShellEnv(): Record<string, string> {
  // Obsidian/Electron doesn't inherit the interactive shell environment,
  // so `node`, NVM paths, etc. are missing from PATH.  Capture the real
  // login-shell environment once and hand it to the SDK so the spawned
  // copilot process (and its #!/usr/bin/env node shebang) can find node.
  const shells = ["/bin/zsh", "/bin/bash"];
  for (const shell of shells) {
    try {
      const raw = execFileSync(shell, ["-l", "-c", "env"], {
        timeout: 5000,
        encoding: "utf8",
      });
      const env: Record<string, string> = {};
      for (const line of raw.split("\n")) {
        const idx = line.indexOf("=");
        if (idx > 0) env[line.slice(0, idx)] = line.slice(idx + 1);
      }
      if (env.PATH) return env;
    } catch (_) {
      // try next shell
    }
  }
  return { ...process.env } as Record<string, string>;
}

function resolveCLIPath(cliPath: string, env: Record<string, string>): string {
  if (cliPath.startsWith("/")) return cliPath; // already absolute

  const shells = ["/bin/zsh", "/bin/bash"];
  for (const shell of shells) {
    try {
      const resolved = execFileSync(shell, ["-l", "-c", `which ${cliPath}`], {
        timeout: 5000,
        encoding: "utf8",
      }).trim();
      if (resolved && existsSync(resolved)) return resolved;
    } catch (_) {
      // try next shell
    }
  }

  // Fallback: scan common NVM bin dirs
  const home = env.HOME ?? process.env.HOME ?? `/Users/${process.env.USER}`;
  const nvmDir = env.NVM_DIR ?? process.env.NVM_DIR ?? `${home}/.nvm`;
  try {
    const bins = execSync(`ls "${nvmDir}/versions/node/"`, { encoding: "utf8" })
      .trim().split("\n");
    for (const ver of bins.reverse()) { // newest first
      const candidate = `${nvmDir}/versions/node/${ver}/bin/${cliPath}`;
      if (existsSync(candidate)) return candidate;
    }
  } catch (_) {}

  return cliPath; // give up and let the SDK surface its own error
}

// ─── Find @github/copilot/index.js at runtime ────────────────────────────────
// The SDK spawns this JS file with --headless --stdio as a subprocess.
// We search: global npm root, common install dirs, and NVM paths.
function resolveBundledCLI(env: Record<string, string>): string | null {
  // 1. Try Node's require.resolve (works if @github/copilot is installed
  //    alongside the plugin or globally and NODE_PATH is set)
  try {
    const mod = require("module");
    const r = mod.createRequire(__filename);
    const resolved = r.resolve("@github/copilot/index.js");
    if (existsSync(resolved)) return resolved;
  } catch (_) {}

  // 2. Ask npm for its global root and check there
  const shells = ["/bin/zsh", "/bin/bash"];
  for (const shell of shells) {
    try {
      const globalRoot = execFileSync(shell, ["-l", "-c", "npm root -g"], {
        timeout: 5000, encoding: "utf8",
      }).trim();
      const candidate = join(globalRoot, "@github", "copilot", "index.js");
      if (existsSync(candidate)) return candidate;
    } catch (_) {}
  }

  // 3. Scan common global node_modules locations
  const home = env.HOME ?? process.env.HOME ?? "";
  const candidates = [
    // Homebrew (Apple Silicon & Intel)
    "/opt/homebrew/lib/node_modules/@github/copilot/index.js",
    "/usr/local/lib/node_modules/@github/copilot/index.js",
    // NVM current
    join(home, ".nvm/versions/node"),
  ];
  for (const c of candidates) {
    if (c.includes(".nvm")) {
      // Scan NVM versions for the package
      try {
        const vers = execSync(`ls "${c}"`, { encoding: "utf8" }).trim().split("\n");
        for (const v of vers.reverse()) {
          const nvmCandidate = join(c, v, "lib/node_modules/@github/copilot/index.js");
          if (existsSync(nvmCandidate)) return nvmCandidate;
        }
      } catch (_) {}
    } else if (existsSync(c)) {
      return c;
    }
  }

  return null;
}

// ─── Type shims for the Copilot SDK ───────────────────────────────────────
type CopilotClientInstance = any;
type CopilotSessionInstance = any;

export type StreamChunkCallback = (chunk: string) => void;
export type StreamDoneCallback = (fullContent: string) => void;
export type ErrorCallback = (error: Error) => void;

export class CopilotClientManager {
  private client: CopilotClientInstance | null = null;
  private session: CopilotSessionInstance | null = null;
  private settings: CopilotPluginSettings;
  private tools: any[];
  private isConnected = false;

  // ── Auto-reconnect / heartbeat state ──────────────────────────────────
  private heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 6;
  private isManualDisconnect = false;
  private isReconnecting = false;
  private onStateChange: ((state: ConnectionState) => void) | null = null;

  // Swallow the SDK's internal write-after-destroy rejections that
  // surface when the CLI subprocess exits before the JSON-RPC writer
  // finishes draining.  Without this the uncaught promise crashes
  // Obsidian's renderer process.
  private rejectionHandler = (event: PromiseRejectionEvent) => {
    const msg = event?.reason?.message ?? "";
    if (msg.includes("write after a stream was destroyed")) {
      event.preventDefault();
      console.warn("[Copilot] suppressed SDK stream write-after-destroy");
    }
  };

  constructor(settings: CopilotPluginSettings, tools: any[]) {
    this.settings = settings;
    this.tools = tools;
    window.addEventListener("unhandledrejection", this.rejectionHandler);
  }

  // Replaces any previously registered callback — safe to call multiple times.
  setOnStateChange(cb: (state: ConnectionState) => void): void {
    this.onStateChange = cb;
  }

  // ── Connect & initialize session ────────────────────────────────────────
  async connect(): Promise<void> {
    this.isManualDisconnect = false;
    try {
      await this.reconnectInternal();
    } catch (err: any) {
      this.isConnected = false;
      throw new Error(this.formatConnectionError(err));
    }
  }

  // ── Internal reconnect (shared by connect() and auto-reconnect) ─────────
  private async reconnectInternal(): Promise<void> {
    // Clean up any existing client/session first.
    // Grab refs before nulling so we can tear down without races.
    const oldSession = this.session;
    const oldClient = this.client;
    this.session = null;
    this.client = null;

    if (oldSession || oldClient) {
      try {
        await oldSession?.close?.();
      } catch (_) {}
      try {
        await oldClient?.stop?.();
      } catch (_) {}
      // Let the underlying streams finish draining / destroying
      // before we spawn a new subprocess on the same stdio fds.
      await new Promise((r) => setTimeout(r, 200));
    }

    // Map our tool definitions to SDK format
    const sdkTools = this.tools.map((tool) =>
      defineTool(tool.name, {
        description: tool.description,
        parameters: tool.parameters,
        handler: tool.handler,
      })
    );

    // Pass the login-shell env so the spawned copilot process can find
    // Node and other binaries that Obsidian/Electron doesn't inherit.
    // The SDK needs @github/copilot/index.js (which supports --headless
    // --stdio).  Resolve it at runtime so the plugin works on any machine.
    const shellEnv = resolveShellEnv();
    const clientOptions: any = { env: shellEnv };

    const customCLI = this.settings.cliPath?.trim();
    if (customCLI && customCLI !== "copilot") {
      clientOptions.cliPath = customCLI.startsWith("/")
        ? customCLI
        : resolveCLIPath(customCLI, shellEnv);
    } else {
      const bundled = resolveBundledCLI(shellEnv);
      if (bundled) {
        clientOptions.cliPath = bundled;
      } else {
        throw new Error(
          "@github/copilot package not found. Install it globally:\n" +
          "  npm install -g @github/copilot\n" +
          "Then reload the plugin."
        );
      }
    }

    this.client = new CopilotClientSDK(clientOptions);
    await this.createSession(sdkTools);

    this.isConnected = true;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.stopHeartbeat();
    this.startHeartbeat();
    this.onStateChange?.("connected");
  }

  private async createSession(sdkTools: any[]): Promise<void> {
    if (this.session) {
      await this.session.close?.();
      this.session = null;
    }

    // Build custom agents array for the SDK
    const customAgents = this.settings.customAgents.map((agent) => ({
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      prompt: agent.prompt,
      tools: null, // all tools available
    }));

    // Built-in MCP server integrations toggled from plugin settings.
    // Microsoft Work IQ exposes the user's M365 data (email, calendar,
    // Teams, files) over the MCP stdio protocol. The package handles its
    // own auth — users must run `workiq accept-eula` and sign in via
    // their terminal once before enabling this toggle.
    const mcpServers: Record<string, any> = {};
    if (this.settings.enableWorkIQ) {
      mcpServers.workiq = {
        type: "stdio",
        command: "npx",
        args: ["-y", "@microsoft/workiq@latest", "mcp"],
      };
    }

    this.session = await this.client.createSession({
      ...(this.settings.model ? { model: this.settings.model } : {}),
      streaming: this.settings.streamResponses,
      tools: sdkTools,
      systemMessage: {
        mode: "replace" as const,
        content: this.settings.systemMessage,
      },
      ...(customAgents.length > 0 ? { customAgents } : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      // Auto-discover .mcp.json / .vscode/mcp.json and skill dirs from cwd
      // (added in @github/copilot-sdk@0.2.2). Lets users drop an MCP config
      // into their vault without per-plugin wiring.
      enableConfigDiscovery: true,
      onPermissionRequest: approveAll,
    });
  }

  // ── Send a message ──────────────────────────────────────────────────────
  async sendMessage(
    content: string,
    onChunk: StreamChunkCallback,
    onDone: StreamDoneCallback,
    onError: ErrorCallback
  ): Promise<void> {
    if (!this.session || !this.isConnected) {
      this.scheduleReconnect();
      onError(new Error("Not connected. Please check the plugin settings and ensure the Copilot CLI is installed."));
      return;
    }

    let fullContent = "";

    try {
      if (this.settings.streamResponses) {
        // Streaming path — SDK method is send({ prompt }), events carry data
        // Unsubscribe handlers after idle/error so they don't stack across sends
        const unsubDelta = this.session.on("assistant.message_delta", (event: any) => {
          const chunk = event.data?.deltaContent ?? "";
          fullContent += chunk;
          onChunk(chunk);
        });

        const unsubIdle = this.session.on("session.idle", () => {
          unsubDelta();
          unsubIdle();
          unsubError();
          onDone(fullContent);
        });

        const unsubError = this.session.on("session.error", (event: any) => {
          unsubDelta();
          unsubIdle();
          unsubError();
          onError(new Error(event.data?.message ?? "Session error"));
        });

        await this.session.send({ prompt: content });
      } else {
        // Non-streaming path — sendAndWait returns the assistant.message event
        const response = await this.session.sendAndWait({ prompt: content });
        fullContent = response?.data?.content ?? "";
        onDone(fullContent);
      }
    } catch (err: any) {
      // Session may have died — mark disconnected and trigger auto-reconnect
      this.isConnected = false;
      this.scheduleReconnect();
      onError(err);
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────
  private startHeartbeat(): void {
    this.heartbeatIntervalId = setInterval(() => {
      // Safety net: if we're disconnected but not actively reconnecting,
      // kick off the reconnect process (covers idle/unexpected drops).
      if (!this.isConnected && this.shouldAttemptReconnect()) {
        this.scheduleReconnect();
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatIntervalId !== null) {
      clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
    }
    if (this.reconnectTimeoutId !== null) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
  }

  private shouldAttemptReconnect(): boolean {
    return !this.isManualDisconnect && !this.isReconnecting;
  }

  // ── Exponential-backoff reconnect ───────────────────────────────────────
  private scheduleReconnect(): void {
    if (!this.shouldAttemptReconnect()) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.onStateChange?.("failed");
      return;
    }

    this.isReconnecting = true;
    // Delays: 2s, 4s, 8s, 16s, 32s, 60s
    const delay = Math.min(Math.pow(2, this.reconnectAttempts + 1) * 1000, 60_000);
    this.reconnectAttempts++;
    this.onStateChange?.("reconnecting");

    this.reconnectTimeoutId = setTimeout(async () => {
      this.reconnectTimeoutId = null;
      if (this.isManualDisconnect) {
        this.isReconnecting = false;
        return;
      }
      try {
        await this.reconnectInternal();
        // Success — reconnectInternal resets state and fires onStateChange('connected')
      } catch (_) {
        this.isReconnecting = false;
        // Schedule the next attempt with a longer delay
        this.scheduleReconnect();
      }
    }, delay);
  }

  // ── Reset session (clears history) ─────────────────────────────────────
  async resetSession(): Promise<void> {
    if (!this.client || !this.isConnected) return;

    try {
      const sdkTools = this.tools.map((tool) =>
        defineTool(tool.name, {
          description: tool.description,
          parameters: tool.parameters,
          handler: tool.handler,
        })
      );
      await this.createSession(sdkTools);
      new Notice("🔄 Copilot session reset");
    } catch (err) {
      new Notice("⚠️ Could not reset session");
    }
  }

  // ── Update settings (reconnect if model changed) ────────────────────────
  async updateSettings(newSettings: CopilotPluginSettings): Promise<void> {
    const modelChanged = newSettings.model !== this.settings.model;
    const systemChanged = newSettings.systemMessage !== this.settings.systemMessage;
    const workIQChanged = newSettings.enableWorkIQ !== this.settings.enableWorkIQ;
    this.settings = newSettings;

    if ((modelChanged || systemChanged || workIQChanged) && this.isConnected && this.client) {
      await this.resetSession();
    }
  }

  // ── Disconnect ───────────────────────────────────────────────────────────
  async disconnect(): Promise<void> {
    this.isManualDisconnect = true;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.stopHeartbeat();
    try {
      await this.session?.close?.();
    } catch (_) {}
    try {
      await this.client?.stop?.();
    } catch (_) {}
    this.session = null;
    this.client = null;
    this.isConnected = false;
    window.removeEventListener("unhandledrejection", this.rejectionHandler);
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  getIsReconnecting(): boolean {
    return this.isReconnecting;
  }

  // ── Format connection errors for users ──────────────────────────────────
  private formatConnectionError(err: any): string {
    const msg: string = err?.message ?? String(err);

    // This is expected during reconnect — old session teardown rejects pending RPCs.
    // Suppress it so users don't see a scary flash on every reconnect.
    if (msg.includes("disposed") || msg.includes("Pending response rejected")) {
      console.warn("[Copilot] suppressed stale-session error:", msg);
      return "";
    }

    if (msg.includes("ENOENT") || msg.includes("not found")) {
      return "Copilot CLI not found. Install it with: npm install -g @github/copilot\nOr set a custom CLI path in plugin settings.";
    }
    if (msg.includes("exited") && (msg.includes("null") || msg.includes("code null"))) {
      return "Copilot CLI crashed on startup. This usually means Node.js can't run the CLI.\n\n" +
        "Fix:\n" +
        "1. Ensure Node.js 18+ is installed: node --version\n" +
        "2. Reinstall the CLI: npm install -g @github/copilot\n" +
        "3. Verify it works: npx @github/copilot --version\n" +
        "4. If using NVM, make sure your default alias is set: nvm alias default node";
    }
    if (msg.includes("exited") && msg.includes("code")) {
      return "Copilot CLI exited unexpectedly.\n\n" +
        "Try:\n" +
        "1. npm install -g @github/copilot\n" +
        "2. Verify: npx @github/copilot --version\n" +
        (msg.includes("stderr") ? `\nCLI output: ${msg.split("stderr:")[1]?.trim() ?? ""}` : "");
    }
    if (msg.includes("auth") || msg.includes("login") || msg.includes("401")) {
      return "Not authenticated with GitHub. Run `copilot /login` in your terminal first.";
    }
    if (msg.includes("subscription") || msg.includes("403")) {
      return "GitHub Copilot subscription required. Check your GitHub account settings.";
    }
    return `Connection failed: ${msg}`;
  }
}
