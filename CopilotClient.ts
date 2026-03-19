import { Notice } from "obsidian";
// @ts-ignore – esbuild will bundle this ESM package into the CJS output
import { CopilotClient as CopilotClientSDK, defineTool, approveAll } from "@github/copilot-sdk";
import { execSync, execFileSync } from "child_process";
import { existsSync } from "fs";
import type { CopilotPluginSettings, ChatMessage } from "./types";

export type ConnectionState = "connected" | "reconnecting" | "failed";

// ─── Resolve the copilot CLI to a full absolute path ─────────────────────────
// Obsidian on macOS doesn't inherit the user's shell PATH (especially NVM),
// so bare command names like "copilot" fail existsSync and spawn.
// We run `which` through a login shell so it picks up ~/.zshrc / ~/.bashrc.
function resolveCLIPath(cliPath: string): string {
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
  const home = process.env.HOME ?? `/Users/${process.env.USER}`;
  const nvmDir = process.env.NVM_DIR ?? `${home}/.nvm`;
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

  constructor(settings: CopilotPluginSettings, tools: any[]) {
    this.settings = settings;
    this.tools = tools;
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
    // Clean up any existing client/session first
    try {
      await this.session?.close?.();
      await this.client?.stop?.();
    } catch (_) {}
    this.session = null;
    this.client = null;

    // Map our tool definitions to SDK format
    const sdkTools = this.tools.map((tool) =>
      defineTool(tool.name, {
        description: tool.description,
        parameters: tool.parameters,
        handler: tool.handler,
      })
    );

    // Always pass cliPath so the SDK never calls getBundledCliPath()
    // (which uses import.meta.resolve and breaks in Obsidian's CJS context).
    // Resolve to an absolute path so existsSync() in the SDK passes and
    // Obsidian's limited PATH doesn't hide NVM-installed binaries.
    const resolvedCLI = resolveCLIPath(this.settings.cliPath);
    const clientOptions: any = { cliPath: resolvedCLI };

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

    this.session = await this.client.createSession({
      model: this.settings.model,
      streaming: this.settings.streamResponses,
      tools: sdkTools,
      systemMessage: this.settings.systemMessage,
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
    this.settings = newSettings;

    if ((modelChanged || systemChanged) && this.isConnected && this.client) {
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
      await this.client?.stop?.();
    } catch (_) {
      // Ignore cleanup errors
    } finally {
      this.session = null;
      this.client = null;
      this.isConnected = false;
    }
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

    if (msg.includes("ENOENT") || msg.includes("not found")) {
      return "Copilot CLI not found. Install it with: npm install -g @github/copilot\nOr set a custom CLI path in plugin settings.";
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
