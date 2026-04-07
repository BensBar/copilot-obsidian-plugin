import {
  ItemView,
  WorkspaceLeaf,
  MarkdownRenderer,
  MarkdownView,
  setIcon,
  Notice,
} from "obsidian";
import type CopilotPlugin from "./main";
import { COPILOT_VIEW_TYPE } from "./types";
import type { ChatMessage, CustomAgent } from "./types";
import type { ConnectionState } from "./CopilotClient";

export class CopilotChatView extends ItemView {
  private plugin: CopilotPlugin;
  private messages: ChatMessage[] = [];
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private statusBar!: HTMLElement;
  private agentDropdownBtn!: HTMLElement;
  private reconnectBannerEl: HTMLElement | null = null;
  private isGenerating = false;
  private thinkingIntervalId: ReturnType<typeof setInterval> | null = null;

  private static readonly THINKING_MESSAGES = [
    "Thinking…",
    "Consulting the knowledge spirits…",
    "Herding semicolons…",
    "Asking the LLM nicely…",
    "Summoning tokens…",
    "Rummaging through training data…",
    "Pretending to think deeply…",
    "Parsing your vault's secrets…",
    "Connecting neurons (borrowed)…",
    "On hold with the AI hotline…",
    "Staring into the void…",
    "Making stuff up with confidence…",
    "Burning GPU cycles for you…",
    "Doing the math (approximately)…",
    "Definitely not just vibing…",
    "Channeling the model…",
    "Generating plausible nonsense…",
    "Translating brain waves…",
    "One moment, computing brilliance…",
    "Bribing the attention heads…",
  ];

  constructor(leaf: WorkspaceLeaf, plugin: CopilotPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return COPILOT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Copilot";
  }

  getIcon(): string {
    return "bot";
  }

  // ── Build the UI ──────────────────────────────────────────────────────
  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("copilot-chat-root");

    // ── Toolbar ──────────────────────────────────────────────────────────
    const toolbar = root.createDiv("copilot-toolbar");
    const titleArea = toolbar.createDiv("copilot-toolbar-title");
    titleArea.createSpan({ cls: "copilot-toolbar-logo", text: "⬡" });
    titleArea.createSpan({ text: "Copilot" });

    // ── Agent dropdown ────────────────────────────────────────────────────
    this.agentDropdownBtn = toolbar.createDiv("copilot-agent-dropdown");
    this.renderAgentDropdown();

    const actions = toolbar.createDiv("copilot-toolbar-actions");

    // Context-note toggle
    const ctxBtn = actions.createEl("button", {
      cls: "copilot-icon-btn",
      attr: { "aria-label": "Toggle active note context" },
    });
    setIcon(ctxBtn, "file-text");
    ctxBtn.toggleClass("active", this.plugin.settings.autoContextActiveNote);
    ctxBtn.addEventListener("click", async () => {
      this.plugin.settings.autoContextActiveNote =
        !this.plugin.settings.autoContextActiveNote;
      ctxBtn.toggleClass("active", this.plugin.settings.autoContextActiveNote);
      await this.plugin.saveSettings();
      new Notice(
        this.plugin.settings.autoContextActiveNote
          ? "📄 Active note context ON"
          : "📄 Active note context OFF"
      );
    });

    // New session button
    const newBtn = actions.createEl("button", {
      cls: "copilot-icon-btn",
      attr: { "aria-label": "New session (clears history)" },
    });
    setIcon(newBtn, "refresh-cw");
    newBtn.addEventListener("click", () => this.resetSession());

    // Settings button
    const settingsBtn = actions.createEl("button", {
      cls: "copilot-icon-btn",
      attr: { "aria-label": "Open Copilot settings" },
    });
    setIcon(settingsBtn, "settings");
    settingsBtn.addEventListener("click", () => {
      // @ts-ignore
      this.app.setting.open();
      // @ts-ignore
      this.app.setting.openTabById("obsidian-copilot");
    });

    // ── Status bar ───────────────────────────────────────────────────────
    this.statusBar = root.createDiv("copilot-status-bar");
    this.updateStatusBar();

    // ── Messages area ────────────────────────────────────────────────────
    this.messagesEl = root.createDiv("copilot-messages");
    this.messagesEl.style.fontSize = this.plugin.settings.chatFontSize;

    // Show welcome message
    this.renderWelcome();

    // ── Input area ───────────────────────────────────────────────────────
    const inputArea = root.createDiv("copilot-input-area");

    const inputWrapper = inputArea.createDiv("copilot-input-wrapper");

    this.inputEl = inputWrapper.createEl("textarea", {
      cls: "copilot-input",
      attr: {
        placeholder: "Ask Copilot anything…",
        rows: "1",
      },
    });

    // Auto-resize textarea
    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 160) + "px";
    });

    // Send on Enter (Shift+Enter for newline)
    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    // Send button
    this.sendBtn = inputWrapper.createEl("button", { cls: "copilot-send-btn" });
    setIcon(this.sendBtn, "send");
    this.sendBtn.addEventListener("click", () => this.handleSend());

    // Quick action pills
    const pills = inputArea.createDiv("copilot-pills");
    const quickActions = [
      { label: "Summarize note", prompt: "Summarize the active note concisely." },
      { label: "Find gaps", prompt: "What's missing from this note? What should I add?" },
      { label: "Create note", prompt: "Based on what we've discussed, create a new note." },
      { label: "Improve writing", prompt: "Improve the writing quality of the active note, keeping the meaning intact." },
    ];
    quickActions.forEach(({ label, prompt }) => {
      const pill = pills.createEl("button", { cls: "copilot-pill", text: label });
      pill.addEventListener("click", () => {
        this.inputEl.value = prompt;
        this.inputEl.dispatchEvent(new Event("input"));
        this.inputEl.focus();
      });
    });

    // ── Auto-connect ─────────────────────────────────────────────────────
    if (!this.plugin.clientManager?.getIsConnected()) {
      this.plugin.connect().then(() => this.refreshManager());
    } else {
      this.setupManagerCallbacks();
    }
  }

  // ── Handle sending a message ──────────────────────────────────────────
  private async handleSend(): Promise<void> {
    const content = this.inputEl.value.trim();
    if (!content || this.isGenerating) return;

    const manager = this.plugin.clientManager;
    if (!manager) {
      new Notice("⚠️ Copilot is not connected. Check plugin settings.");
      return;
    }

    // If disconnected, show the reconnect banner and wait — do NOT send
    if (!manager.getIsConnected()) {
      this.showReconnectingBanner();
      return;
    }

    // Build final prompt — optionally inject active note context.
    // Use the plugin's tracked lastActiveMarkdownView so the reference
    // survives focus moving to this chat panel.
    let finalPrompt = content;

    // Prepend @agent mention if a custom agent is active
    const activeAgentName = this.plugin.settings.activeAgent;
    if (activeAgentName) {
      finalPrompt = `@${activeAgentName} ${finalPrompt}`;
    }

    if (this.plugin.settings.autoContextActiveNote) {
      const view =
        this.plugin.lastActiveMarkdownView ??
        this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view?.file) {
        const noteContent = await this.app.vault.read(view.file);
        finalPrompt = `[Active note: ${view.file.name}]\n\`\`\`\n${noteContent.slice(0, 4000)}\n\`\`\`\n\n${content}`;
      }
    }

    // Clear input
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";

    // Add user message to UI
    this.addMessage({ role: "user", content });

    // Start assistant message (streaming placeholder)
    const assistantId = this.addMessage({ role: "assistant", content: "", isStreaming: true });

    this.isGenerating = true;
    this.sendBtn.disabled = true;
    this.startThinkingMessages();

    let streamBuffer = "";

    manager.sendMessage(
      finalPrompt,
      // onChunk
      (chunk: string) => {
        streamBuffer += chunk;
        this.updateStreamingMessage(assistantId, streamBuffer);
      },
      // onDone
      (fullContent: string) => {
        this.finalizeMessage(assistantId, fullContent || streamBuffer);
        this.isGenerating = false;
        this.sendBtn.disabled = false;
        this.stopThinkingMessages();
        this.trimHistory();
      },
      // onError
      (error: Error) => {
        // If the send failed because the connection dropped, the auto-reconnect
        // is already in progress — remove the empty placeholder and let the
        // banner handle UX rather than showing a red error bubble.
        if (!manager.getIsConnected()) {
          this.removeMessage(assistantId);
        } else {
          this.finalizeMessage(assistantId, `❌ ${error.message}`, true);
        }
        this.isGenerating = false;
        this.sendBtn.disabled = false;
        this.stopThinkingMessages();
      }
    );
  }

  // ── Message rendering ─────────────────────────────────────────────────
  private addMessage(partial: Partial<ChatMessage> & { role: ChatMessage["role"] }): string {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role: partial.role,
      content: partial.content ?? "",
      timestamp: Date.now(),
      isStreaming: partial.isStreaming ?? false,
      error: partial.error ?? false,
    };
    this.messages.push(msg);
    this.renderMessage(msg);
    return msg.id;
  }

  private renderMessage(msg: ChatMessage): void {
    const el = this.messagesEl.createDiv({
      cls: `copilot-message copilot-message-${msg.role}`,
      attr: { "data-id": msg.id },
    });

    // Avatar
    const avatar = el.createDiv("copilot-avatar");
    if (msg.role === "user") {
      setIcon(avatar, "user");
    } else {
      avatar.textContent = "⬡";
    }

    const body = el.createDiv("copilot-message-body");

    // Content
    const contentEl = body.createDiv("copilot-message-content");
    contentEl.setAttribute("data-content", "");

    if (msg.content) {
      if (msg.role === "assistant") {
        MarkdownRenderer.render(this.app, msg.content, contentEl, "", this);
      } else {
        contentEl.textContent = msg.content;
      }
    } else if (msg.isStreaming) {
      contentEl.createSpan({ cls: "copilot-cursor" });
    }

    // Footer row (timestamp + actions)
    const footer = body.createDiv("copilot-message-footer");

    if (this.plugin.settings.showTimestamps) {
      footer.createSpan({
        cls: "copilot-timestamp",
        text: new Date(msg.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
    }

    // Copy button (assistant only)
    if (msg.role === "assistant" && !msg.isStreaming) {
      const copyBtn = footer.createEl("button", {
        cls: "copilot-msg-action",
        attr: { "aria-label": "Copy" },
      });
      setIcon(copyBtn, "copy");
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(msg.content);
        new Notice("Copied to clipboard");
      });

      // Append to note button
      const appendBtn = footer.createEl("button", {
        cls: "copilot-msg-action",
        attr: { "aria-label": "Append to active note" },
      });
      setIcon(appendBtn, "file-plus");
      appendBtn.addEventListener("click", async () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) {
          new Notice("No active note to append to");
          return;
        }
        const existing = await this.app.vault.read(view.file);
        await this.app.vault.modify(view.file, existing + "\n\n" + msg.content);
        new Notice("✅ Appended to note");
      });
    }

    this.scrollToBottom();
  }

  private updateStreamingMessage(id: string, content: string): void {
    const el = this.messagesEl.querySelector(`[data-id="${id}"]`);
    if (!el) return;

    const contentEl = el.querySelector(".copilot-message-content") as HTMLElement;
    if (!contentEl) return;

    contentEl.empty();
    MarkdownRenderer.render(this.app, content, contentEl, "", this);
    // Re-add cursor
    contentEl.createSpan({ cls: "copilot-cursor" });
    this.scrollToBottom();
  }

  private finalizeMessage(id: string, content: string, error = false): void {
    const msg = this.messages.find((m) => m.id === id);
    if (msg) {
      msg.content = content;
      msg.isStreaming = false;
      msg.error = error;
    }

    const el = this.messagesEl.querySelector(`[data-id="${id}"]`);
    if (!el) return;

    if (error) el.addClass("copilot-message-error");

    const contentEl = el.querySelector(".copilot-message-content") as HTMLElement;
    if (contentEl) {
      contentEl.empty();
      if (error) {
        contentEl.textContent = content;
      } else {
        MarkdownRenderer.render(this.app, content, contentEl, "", this);
      }
    }

    // Add footer actions for successful assistant messages
    if (!error && msg?.role === "assistant") {
      const footer = el.querySelector(".copilot-message-footer") as HTMLElement;
      if (footer) {
        const copyBtn = footer.createEl("button", {
          cls: "copilot-msg-action",
          attr: { "aria-label": "Copy" },
        });
        setIcon(copyBtn, "copy");
        copyBtn.addEventListener("click", () => {
          navigator.clipboard.writeText(content);
          new Notice("Copied to clipboard");
        });

        const appendBtn = footer.createEl("button", {
          cls: "copilot-msg-action",
          attr: { "aria-label": "Append to active note" },
        });
        setIcon(appendBtn, "file-plus");
        appendBtn.addEventListener("click", async () => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (!view?.file) {
            new Notice("No active note to append to");
            return;
          }
          const existing = await this.app.vault.read(view.file);
          await this.app.vault.modify(view.file, existing + "\n\n" + content);
          new Notice("✅ Appended to note");
        });
      }
    }

    this.scrollToBottom();
  }

  private appendSystemMessage(text: string, isError = false): void {
    const el = this.messagesEl.createDiv({
      cls: `copilot-system-message ${isError ? "error" : ""}`,
      text,
    });
    this.scrollToBottom();
  }

  // ── Reconnect banner ──────────────────────────────────────────────────
  private showReconnectingBanner(): void {
    if (!this.reconnectBannerEl) {
      this.reconnectBannerEl = createDiv({ cls: "copilot-reconnect-banner" });
      this.messagesEl.insertBefore(this.reconnectBannerEl, this.messagesEl.firstChild);
    }
    this.reconnectBannerEl.empty();
    this.reconnectBannerEl.removeClass("failed");
    this.reconnectBannerEl.createSpan({ cls: "copilot-reconnect-spinner" });
    this.reconnectBannerEl.createSpan({ text: " ⚠️ Disconnected — attempting to reconnect…" });
  }

  private showFailedBanner(): void {
    if (!this.reconnectBannerEl) {
      this.reconnectBannerEl = createDiv({ cls: "copilot-reconnect-banner" });
      this.messagesEl.insertBefore(this.reconnectBannerEl, this.messagesEl.firstChild);
    }
    this.reconnectBannerEl.empty();
    this.reconnectBannerEl.addClass("failed");
    this.reconnectBannerEl.createSpan({ text: "❌ Could not reconnect. " });
    const link = this.reconnectBannerEl.createEl("a", {
      text: "Go to Settings to reconnect manually.",
      href: "#",
    });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      // @ts-ignore
      this.app.setting.open();
      // @ts-ignore
      this.app.setting.openTabById("obsidian-copilot");
    });
  }

  private hideReconnectBanner(): void {
    if (this.reconnectBannerEl) {
      this.reconnectBannerEl.remove();
      this.reconnectBannerEl = null;
    }
  }

  // ── Connection state callback (called by CopilotClientManager) ────────
  handleConnectionState(state: ConnectionState): void {
    if (state === "connected") {
      this.hideReconnectBanner();
      if (!this.isGenerating) this.sendBtn.disabled = false;
      this.updateStatusBar();
    } else if (state === "reconnecting") {
      this.showReconnectingBanner();
      this.sendBtn.disabled = true;
      this.updateStatusBar();
    } else if (state === "failed") {
      this.showFailedBanner();
      this.sendBtn.disabled = false;
      this.updateStatusBar();
    }
  }

  // ── Register callbacks on the active client manager ───────────────────
  private setupManagerCallbacks(): void {
    this.plugin.clientManager?.setOnStateChange((state) => {
      this.handleConnectionState(state);
    });
  }

  // ── Called after a new manager is created (e.g. reconnect from settings) ─
  refreshManager(): void {
    this.setupManagerCallbacks();
    this.hideReconnectBanner();
    this.updateStatusBar();
  }

  private renderWelcome(): void {
    const welcome = this.messagesEl.createDiv("copilot-welcome");
    welcome.createDiv({ cls: "copilot-welcome-logo", text: "⬡" });
    welcome.createEl("h3", { text: "GitHub Copilot" });
    welcome.createEl("p", {
      text: "Ask me anything about your vault, your notes, or anything else. I can read, create, and edit your notes.",
    });

    const caps = welcome.createDiv("copilot-welcome-caps");
    [
      ["📄", "Read & write notes"],
      ["🔍", "Search your vault"],
      ["✍️", "Generate content"],
      ["🤖", "Custom agents"],
    ].forEach(([icon, label]) => {
      const cap = caps.createDiv("copilot-cap");
      cap.createSpan({ text: icon });
      cap.createSpan({ text: label });
    });
  }

  // ── Utilities ─────────────────────────────────────────────────────────
  private async resetSession(): Promise<void> {
    await this.plugin.clientManager?.resetSession();
    this.messages = [];
    this.messagesEl.empty();
    this.renderWelcome();
    this.updateStatusBar();
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private removeMessage(id: string): void {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx !== -1) this.messages.splice(idx, 1);
    this.messagesEl.querySelector(`[data-id="${id}"]`)?.remove();
  }

  // ── Witty thinking messages ───────────────────────────────────────────
  private startThinkingMessages(): void {
    const messages = CopilotChatView.THINKING_MESSAGES;
    // Pick a random starting index so it's not always "Thinking…" first
    let idx = Math.floor(Math.random() * messages.length);
    this.updateStatusBar(messages[idx]);

    this.thinkingIntervalId = setInterval(() => {
      idx = (idx + 1) % messages.length;
      this.updateStatusBar(messages[idx]);
    }, 2500);
  }

  private stopThinkingMessages(): void {
    if (this.thinkingIntervalId !== null) {
      clearInterval(this.thinkingIntervalId);
      this.thinkingIntervalId = null;
    }
    this.updateStatusBar();
  }

  private trimHistory(): void {
    const max = this.plugin.settings.maxHistoryLength;
    while (this.messages.length > max) {
      this.messages.shift();
      const first = this.messagesEl.firstElementChild;
      if (first?.classList.contains("copilot-message")) first.remove();
    }
  }

  updateStatusBar(customText?: string): void {
    if (!this.statusBar) return;
    this.statusBar.empty();

    if (customText) {
      this.statusBar.createSpan({ cls: "copilot-status-dot thinking" });
      this.statusBar.createSpan({ text: customText });
      return;
    }

    const connected = this.plugin.clientManager?.getIsConnected() ?? false;
    const dot = this.statusBar.createSpan({ cls: `copilot-status-dot ${connected ? "connected" : "disconnected"}` });
    const model = this.plugin.settings.model;
    const label = connected
      ? `${model}`
      : "Disconnected — click to reconnect";
    this.statusBar.createSpan({ text: label, cls: "copilot-status-text" });

    if (!connected) {
      this.statusBar.style.cursor = "pointer";
      this.statusBar.addEventListener("click", () => {
        this.plugin.connect().then(() => this.refreshManager());
      });
    }
  }

  updateFontSize(size: string): void {
    if (this.messagesEl) this.messagesEl.style.fontSize = size;
  }

  // ── Agent dropdown ────────────────────────────────────────────────────
  private renderAgentDropdown(): void {
    this.agentDropdownBtn.empty();
    const agents = this.plugin.settings.customAgents;
    const active = this.plugin.settings.activeAgent;
    const activeAgent = agents.find((a) => a.name === active);

    const label = this.agentDropdownBtn.createSpan({
      cls: "copilot-agent-label",
      text: activeAgent?.displayName ?? "Default",
    });
    const chevron = this.agentDropdownBtn.createSpan({ cls: "copilot-agent-chevron", text: "▾" });

    this.agentDropdownBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showAgentMenu();
    });
  }

  private showAgentMenu(): void {
    // Remove existing menu if open
    const existing = this.containerEl.querySelector(".copilot-agent-menu");
    if (existing) { existing.remove(); return; }

    const menu = createDiv("copilot-agent-menu");
    const agents = this.plugin.settings.customAgents;
    const active = this.plugin.settings.activeAgent;

    // Default option
    const defaultItem = menu.createDiv({
      cls: `copilot-agent-item ${active === "" ? "active" : ""}`,
    });
    defaultItem.createSpan({ cls: "copilot-agent-item-name", text: "Default" });
    defaultItem.createSpan({ cls: "copilot-agent-item-desc", text: "General assistant" });
    defaultItem.addEventListener("click", () => this.selectAgent(""));

    // Custom agents
    agents.forEach((agent) => {
      const item = menu.createDiv({
        cls: `copilot-agent-item ${active === agent.name ? "active" : ""}`,
      });
      item.createSpan({ cls: "copilot-agent-item-name", text: agent.displayName });
      item.createSpan({ cls: "copilot-agent-item-desc", text: agent.description });
      item.addEventListener("click", () => this.selectAgent(agent.name));
    });

    // Position relative to the dropdown button
    const rect = this.agentDropdownBtn.getBoundingClientRect();
    const rootRect = this.containerEl.getBoundingClientRect();
    menu.style.top = `${rect.bottom - rootRect.top + 4}px`;
    menu.style.left = `${rect.left - rootRect.left}px`;

    this.containerEl.children[1].appendChild(menu);

    // Close on click outside
    const closeHandler = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener("click", closeHandler);
      }
    };
    setTimeout(() => document.addEventListener("click", closeHandler), 0);
  }

  private async selectAgent(agentName: string): Promise<void> {
    this.plugin.settings.activeAgent = agentName;
    await this.plugin.saveSettings();
    this.renderAgentDropdown();

    // Remove menu
    this.containerEl.querySelector(".copilot-agent-menu")?.remove();

    // Reset session so the agent takes effect
    if (this.plugin.clientManager?.getIsConnected()) {
      await this.plugin.clientManager.updateSettings(this.plugin.settings);
      new Notice(agentName ? `Switched to ${this.plugin.settings.customAgents.find(a => a.name === agentName)?.displayName}` : "Switched to Default");
    }
  }

  async onClose(): Promise<void> {
    // Nothing to clean up — session is managed by the plugin
  }
}
