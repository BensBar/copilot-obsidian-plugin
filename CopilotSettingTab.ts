import { App, PluginSettingTab, Setting, DropdownComponent } from "obsidian";
import type CopilotPlugin from "./main";
import { AVAILABLE_MODELS } from "./types";
import type { CustomAgent } from "./types";

export class CopilotSettingTab extends PluginSettingTab {
  plugin: CopilotPlugin;

  constructor(app: App, plugin: CopilotPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Header ────────────────────────────────────────────────────────────
    const header = containerEl.createDiv("copilot-settings-header");
    header.createEl("div", { cls: "copilot-settings-logo", text: "⬡" });
    header.createEl("h2", { text: "GitHub Copilot" });
    header.createEl("p", {
      cls: "copilot-settings-subtitle",
      text: "Configure your Copilot integration. Requires the Copilot CLI installed and authenticated.",
    });

    // ── Connection ────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Connection", cls: "copilot-settings-section" });

    new Setting(containerEl)
      .setName("Copilot CLI path")
      .setDesc(
        "Path to the GitHub Copilot CLI binary. Leave as 'copilot' if it's on your system PATH. Install: npm install -g @github/copilot"
      )
      .addText((text) =>
        text
          .setPlaceholder("copilot")
          .setValue(this.plugin.settings.cliPath)
          .onChange(async (value) => {
            this.plugin.settings.cliPath = value.trim() || "copilot";
            await this.plugin.saveSettings();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Test connection")
          .setCta()
          .onClick(async () => {
            btn.setButtonText("Testing…");
            btn.setDisabled(true);
            const ok = await this.plugin.testConnection();
            btn.setButtonText(ok ? "✅ Connected" : "❌ Failed");
            btn.setDisabled(false);
            setTimeout(() => btn.setButtonText("Test connection"), 3000);
          })
      );

    // ── Model ─────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Model", cls: "copilot-settings-section" });

    new Setting(containerEl)
      .setName("AI model")
      .setDesc("The model used for all Copilot interactions. Changes apply on next session reset.")
      .addDropdown((drop: DropdownComponent) => {
        AVAILABLE_MODELS.forEach((m) => drop.addOption(m.value, m.label));
        drop.setValue(this.plugin.settings.model);
        drop.onChange(async (value) => {
          this.plugin.settings.model = value;
          await this.plugin.saveSettings();
          await this.plugin.clientManager?.updateSettings(this.plugin.settings);
        });
      });

    new Setting(containerEl)
      .setName("Stream responses")
      .setDesc("Show AI responses as they are generated, token by token.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.streamResponses).onChange(async (value) => {
          this.plugin.settings.streamResponses = value;
          await this.plugin.saveSettings();
        })
      );

    // ── Behavior ──────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Behavior", cls: "copilot-settings-section" });

    new Setting(containerEl)
      .setName("System message")
      .setDesc(
        "The system prompt sent to Copilot at the start of every session. Customize Copilot's persona and focus area."
      )
      .addTextArea((text) => {
        text.inputEl.rows = 5;
        text.inputEl.style.width = "100%";
        text
          .setPlaceholder("You are a helpful assistant…")
          .setValue(this.plugin.settings.systemMessage)
          .onChange(async (value) => {
            this.plugin.settings.systemMessage = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Auto-include active note")
      .setDesc(
        "Automatically prepend the content of your active note as context with every message."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoContextActiveNote)
          .onChange(async (value) => {
            this.plugin.settings.autoContextActiveNote = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max history length")
      .setDesc("Maximum number of messages to keep in the chat UI (older ones are trimmed).")
      .addSlider((slider) =>
        slider
          .setLimits(10, 200, 10)
          .setValue(this.plugin.settings.maxHistoryLength)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxHistoryLength = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Agents ─────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Agents", cls: "copilot-settings-section" });

    const agentsDesc = new Setting(containerEl)
      .setName("Custom agents")
      .setDesc("Define agents with specialized prompts. Select them from the dropdown in the chat toolbar.");

    // Render each existing agent
    const agentsContainer = containerEl.createDiv("copilot-agents-list");
    this.renderAgentsList(agentsContainer);

    // Add agent button
    new Setting(containerEl)
      .addButton((btn) =>
        btn
          .setButtonText("+ Add agent")
          .onClick(async () => {
            this.plugin.settings.customAgents.push({
              name: `agent-${Date.now()}`,
              displayName: "New Agent",
              description: "Describe what this agent does",
              prompt: "You are a helpful assistant.",
            });
            await this.plugin.saveSettings();
            this.renderAgentsList(agentsContainer);
          })
      );

    // ── Appearance ────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Appearance", cls: "copilot-settings-section" });

    new Setting(containerEl)
      .setName("Show timestamps")
      .setDesc("Display time sent beneath each message.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showTimestamps).onChange(async (value) => {
          this.plugin.settings.showTimestamps = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Chat font size")
      .setDesc("Font size for the chat panel text.")
      .addDropdown((drop) => {
        ["12px", "13px", "14px", "15px", "16px"].forEach((s) => drop.addOption(s, s));
        drop.setValue(this.plugin.settings.chatFontSize);
        drop.onChange(async (value) => {
          this.plugin.settings.chatFontSize = value;
          await this.plugin.saveSettings();
          this.plugin.updateChatFontSize();
        });
      });

    // ── About ─────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "About", cls: "copilot-settings-section" });

    const about = containerEl.createDiv("copilot-settings-about");
    about.createEl("p", {
      text: "This plugin uses the GitHub Copilot SDK (Technical Preview). Copilot CLI must be installed separately and authenticated with your GitHub account. Each prompt consumes one premium request from your Copilot plan.",
    });
    const link = about.createEl("a", {
      text: "→ GitHub Copilot CLI docs",
      href: "https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line",
    });
    link.target = "_blank";
  }

  private renderAgentsList(container: HTMLElement): void {
    container.empty();
    const agents = this.plugin.settings.customAgents;

    agents.forEach((agent, index) => {
      const card = container.createDiv("copilot-agent-card");

      // Header row: display name + delete
      const headerRow = card.createDiv("copilot-agent-card-header");

      new Setting(headerRow)
        .setName("Display name")
        .addText((text) =>
          text.setValue(agent.displayName).onChange(async (value) => {
            agent.displayName = value;
            await this.plugin.saveSettings();
          })
        );

      new Setting(card)
        .setName("Identifier")
        .setDesc("Used internally and for @mentions (no spaces)")
        .addText((text) =>
          text.setValue(agent.name).onChange(async (value) => {
            agent.name = value.replace(/\s/g, "-").toLowerCase();
            await this.plugin.saveSettings();
          })
        );

      new Setting(card)
        .setName("Description")
        .addText((text) =>
          text.setValue(agent.description).onChange(async (value) => {
            agent.description = value;
            await this.plugin.saveSettings();
          })
        );

      const promptSetting = new Setting(card)
        .setName("Prompt");
      const textarea = promptSetting.controlEl.createEl("textarea", {
        cls: "copilot-agent-prompt-input",
      });
      textarea.value = agent.prompt;
      textarea.rows = 3;
      textarea.addEventListener("change", async () => {
        agent.prompt = textarea.value;
        await this.plugin.saveSettings();
      });

      new Setting(card)
        .addButton((btn) =>
          btn
            .setButtonText("Delete")
            .setWarning()
            .onClick(async () => {
              this.plugin.settings.customAgents.splice(index, 1);
              if (this.plugin.settings.activeAgent === agent.name) {
                this.plugin.settings.activeAgent = "";
              }
              await this.plugin.saveSettings();
              this.renderAgentsList(container);
            })
        );
    });
  }
}
