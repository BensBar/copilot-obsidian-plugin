// Slash commands surfaced in the chat input via the autocomplete popup.
// Two flavors:
//   - prompt:  expands the input into a templated prompt that gets sent as
//              a normal user message
//   - action:  invoked locally on the chat view (no message is sent),
//              receives the trimmed argument string after the command name

export type SlashAction = "clear" | "agent" | "model" | "help" | "settings";

export interface SlashCommand {
  name: string;             // canonical command name without the leading "/"
  description: string;      // shown in the popup
  // Exactly one of these must be set:
  prompt?: string;          // sent as the user message when invoked
  action?: SlashAction;     // handled locally by CopilotChatView
  argHint?: string;         // optional placeholder shown after the command (e.g. "<name>")
}

export const SLASH_COMMANDS: SlashCommand[] = [
  // ── Prompt expansions ────────────────────────────────────────────────
  {
    name: "summarize",
    description: "Summarize the active note",
    prompt: "Summarize the active note concisely.",
  },
  {
    name: "gaps",
    description: "Find what's missing from the active note",
    prompt: "Read the active note and tell me what's missing or could be expanded. Be specific.",
  },
  {
    name: "improve",
    description: "Improve the writing of the active note",
    prompt: "Improve the writing quality of the active note. Preserve the meaning and the author's voice.",
  },
  {
    name: "outline",
    description: "Generate a structured outline for the active note",
    prompt: "Create a clear hierarchical outline of the active note's content and topics.",
  },
  {
    name: "related",
    description: "Find related notes in the vault",
    prompt: "Search the vault for notes related to the active note's topic and list them with a one-line summary each.",
  },
  {
    name: "tag",
    description: "Suggest tags for the active note",
    prompt: "Suggest 3-7 tags for the active note based on its content. Return them as a markdown list of #hashtags.",
  },
  {
    name: "todo",
    description: "Extract action items from the active note",
    prompt: "Extract every actionable task or TODO from the active note as a markdown checklist.",
  },
  {
    name: "translate",
    description: "Translate the active note",
    argHint: "<language>",
    prompt: "Translate the active note into {arg}. Preserve markdown structure.",
  },
  {
    name: "explain",
    description: "Explain a concept in plain language",
    argHint: "<concept>",
    prompt: "Explain {arg} clearly and concisely, as if to a curious newcomer.",
  },

  // ── Local actions ─────────────────────────────────────────────────────
  {
    name: "clear",
    description: "Start a new session (clears chat history)",
    action: "clear",
  },
  {
    name: "agent",
    description: "Switch to a custom agent",
    argHint: "<name>",
    action: "agent",
  },
  {
    name: "model",
    description: "Switch the active model",
    argHint: "<model>",
    action: "model",
  },
  {
    name: "settings",
    description: "Open Copilot settings",
    action: "settings",
  },
  {
    name: "help",
    description: "Show all slash commands",
    action: "help",
  },
];

// Returns commands whose name starts with the given query (case-insensitive).
// Empty query returns all commands.
export function filterCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(q));
}

// Longest common prefix among candidate names — used for Tab autofill so
// `/sum<Tab>` → `/summarize` and `/g<Tab>` → `/gaps`.
export function longestCommonPrefix(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  let prefix = names[0];
  for (let i = 1; i < names.length; i++) {
    while (!names[i].toLowerCase().startsWith(prefix.toLowerCase())) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return "";
    }
  }
  return prefix;
}
