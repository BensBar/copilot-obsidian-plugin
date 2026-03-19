export interface CopilotPluginSettings {
  // Connection
  cliPath: string;
  model: string;

  // Behavior
  systemMessage: string;
  streamResponses: boolean;
  autoContextActiveNote: boolean;

  // UI
  showTimestamps: boolean;
  chatFontSize: string;

  // Session
  maxHistoryLength: number;
}

export const DEFAULT_SETTINGS: CopilotPluginSettings = {
  cliPath: "copilot",
  model: "claude-sonnet-4-5",
  systemMessage:
    "You are a knowledgeable AI assistant embedded in Obsidian. You help the user manage their personal knowledge base, draft notes, summarize content, connect ideas, and answer questions. Be concise, thoughtful, and markdown-aware.",
  streamResponses: true,
  autoContextActiveNote: false,
  showTimestamps: true,
  chatFontSize: "14px",
  maxHistoryLength: 50,
};

export const AVAILABLE_MODELS = [
  { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5 (Default)" },
  { value: "claude-sonnet-4", label: "Claude Sonnet 4" },
  { value: "gpt-5", label: "GPT-5" },
  { value: "gpt-4.1", label: "GPT-4.1" },
  { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
];

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  error?: boolean;
}

export const COPILOT_VIEW_TYPE = "copilot-chat-view";
