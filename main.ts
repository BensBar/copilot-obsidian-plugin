import { Plugin, WorkspaceLeaf, Notice, addIcon, MarkdownView } from "obsidian";
import { CopilotChatView } from "./CopilotChatView";
import { CopilotClientManager } from "./CopilotClient";
import { CopilotSettingTab } from "./CopilotSettingTab";
import { buildVaultTools } from "./tools";
import {
  COPILOT_VIEW_TYPE,
  DEFAULT_SETTINGS,
  type CopilotPluginSettings,
} from "./types";

// Register a custom SVG icon for the sidebar
const COPILOT_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

export default class CopilotPlugin extends Plugin {
  settings!: CopilotPluginSettings;
  clientManager: CopilotClientManager | null = null;
  lastActiveMarkdownView: MarkdownView | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Track the last focused MarkdownView so tools can still reference it
    // even when focus has moved to the Copilot chat panel.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const view = leaf?.view;
        if (view instanceof MarkdownView) {
          this.lastActiveMarkdownView = view;
        }
      })
    );

    // Register sidebar icon
    addIcon("copilot-star", COPILOT_ICON_SVG);

    // Register the chat view
    this.registerView(COPILOT_VIEW_TYPE, (leaf) => new CopilotChatView(leaf, this));

    // Ribbon button
    this.addRibbonIcon("bot", "Open Copilot", () => this.activateView());

    // Command palette entries
    this.addCommand({
      id: "open-copilot",
      name: "Open Copilot chat",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "copilot-ask-selection",
      name: "Ask Copilot about selection",
      editorCallback: async (editor) => {
        const selected = editor.getSelection();
        if (!selected) {
          new Notice("Select some text first");
          return;
        }
        await this.activateView();
        // Small delay to let the view mount
        setTimeout(() => {
          const view = this.getActiveView();
          if (view) {
            // @ts-ignore - access inputEl
            const input = (view as any).inputEl as HTMLTextAreaElement;
            if (input) {
              input.value = `Explain this:\n\n\`\`\`\n${selected}\n\`\`\``;
              input.dispatchEvent(new Event("input"));
              input.focus();
            }
          }
        }, 200);
      },
    });

    this.addCommand({
      id: "copilot-summarize-note",
      name: "Summarize active note with Copilot",
      callback: async () => {
        await this.activateView();
        setTimeout(() => {
          const view = this.getActiveView();
          if (view) {
            // @ts-ignore
            const input = (view as any).inputEl as HTMLTextAreaElement;
            if (input) {
              input.value = "Summarize the active note concisely.";
              input.dispatchEvent(new Event("input"));
            }
          }
        }, 200);
      },
    });

    this.addCommand({
      id: "copilot-reset-session",
      name: "Reset Copilot session",
      callback: async () => {
        await this.clientManager?.resetSession();
      },
    });

    // Settings tab
    this.addSettingTab(new CopilotSettingTab(this.app, this));

    // Auto-connect on load
    this.app.workspace.onLayoutReady(() => {
      // Seed lastActiveMarkdownView so it's available immediately on first use,
      // even if the user hasn't switched leaves yet after loading.
      this.lastActiveMarkdownView =
        this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!this.lastActiveMarkdownView) {
        const leaves = this.app.workspace.getLeavesOfType("markdown");
        for (const leaf of leaves) {
          if (leaf.view instanceof MarkdownView && leaf.view.file) {
            this.lastActiveMarkdownView = leaf.view as MarkdownView;
            break;
          }
        }
      }

      this.connect().catch(() => {
        // Silently fail on startup — user will see status in panel
      });
    });
  }

  async onunload(): Promise<void> {
    await this.clientManager?.disconnect();
  }

  // ── Connection management ─────────────────────────────────────────────
  async connect(): Promise<boolean> {
    try {
      const tools = buildVaultTools(this.app, () =>
        this.lastActiveMarkdownView ?? this.app.workspace.getActiveViewOfType(MarkdownView)
      );

      if (this.clientManager) {
        await this.clientManager.disconnect();
      }

      this.clientManager = new CopilotClientManager(this.settings, tools);
      await this.clientManager.connect();

      // Update all open view status bars and re-register manager callbacks
      this.getOpenViews().forEach((v) => v.refreshManager());
      return true;
    } catch (err: any) {
      new Notice(`⚠️ Copilot: ${err.message}`, 8000);
      this.getOpenViews().forEach((v) => v.updateStatusBar());
      return false;
    }
  }

  async testConnection(): Promise<boolean> {
    return this.connect();
  }

  // ── View management ───────────────────────────────────────────────────
  async activateView(): Promise<void> {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const existing = workspace.getLeavesOfType(COPILOT_VIEW_TYPE);

    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: COPILOT_VIEW_TYPE, active: true });
    }

    workspace.revealLeaf(leaf);
  }

  private getOpenViews(): CopilotChatView[] {
    return this.app.workspace
      .getLeavesOfType(COPILOT_VIEW_TYPE)
      .map((l) => l.view as CopilotChatView);
  }

  private getActiveView(): CopilotChatView | null {
    const leaves = this.app.workspace.getLeavesOfType(COPILOT_VIEW_TYPE);
    return leaves.length > 0 ? (leaves[0].view as CopilotChatView) : null;
  }

  // ── Settings ──────────────────────────────────────────────────────────
  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  updateChatFontSize(): void {
    this.getOpenViews().forEach((v) => v.updateFontSize(this.settings.chatFontSize));
  }
}
