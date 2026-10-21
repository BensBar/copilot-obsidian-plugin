export interface CustomAgent {
  name: string;
  displayName: string;
  description: string;
  prompt: string;
}

export interface CopilotPluginSettings {
  // Connection
  cliPath: string;
  model: string;

  // Behavior
  systemMessage: string;
  streamResponses: boolean;
  autoContextActiveNote: boolean;
  enableShellTool: boolean;

  // Integrations
  enableWorkIQ: boolean;

  // Agents
  customAgents: CustomAgent[];
  activeAgent: string; // name of active agent, "" = default (no agent)

  // UI
  showTimestamps: boolean;
  chatFontSize: string;

  // Session
  maxHistoryLength: number;
}

export const DEFAULT_SETTINGS: CopilotPluginSettings = {
  cliPath: "copilot",
  model: "",
  systemMessage:
    "You are a knowledgeable AI assistant embedded in Obsidian. You help the user manage their personal knowledge base, draft notes, summarize content, connect ideas, and answer questions. Be concise, thoughtful, and markdown-aware.",
  streamResponses: true,
  autoContextActiveNote: false,
  enableShellTool: true,
  enableWorkIQ: false,
  customAgents: [
    {
      name: "writer",
      displayName: "Writer",
      description: "Helps with prose, tone, and clarity",
      prompt: "You are a skilled writing assistant. Help the user improve their prose, adjust tone, fix grammar, and write clearly. Be direct and concise. Preserve the author's voice.",
    },
    {
      name: "researcher",
      displayName: "Researcher",
      description: "Deep analysis and knowledge synthesis",
      prompt: "You are a research assistant. Help the user analyze topics deeply, find connections between ideas, synthesize information, and organize knowledge. Cite reasoning. Be thorough but structured.",
    },
    {
      name: "coder",
      displayName: "Coder",
      description: "Code snippets and technical help",
      prompt: "You are a senior software engineer. Help the user with code snippets, debugging, architecture, and technical explanations. Prefer concise, idiomatic code. Use markdown code blocks.",
    },
  ],
  activeAgent: "",
  showTimestamps: true,
  chatFontSize: "14px",
  maxHistoryLength: 50,
};

// A selectable model entry. `multiplier` and `reasoningEfforts` are populated
// when the list comes live from the SDK (`client.listModels()`); the hardcoded
// fallback list below only fills `value`/`label`.
export interface ModelOption {
  value: string;
  label: string;
  multiplier?: number;
  reasoningEfforts?: string[];
}

export const AVAILABLE_MODELS: ModelOption[] = [
  { value: "", label: "Default (auto)" },
  // Claude
  { value: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
  { value: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
  { value: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { value: "claude-opus-4.8", label: "Claude Opus 4.8" },
  { value: "claude-opus-4.7", label: "Claude Opus 4.7" },
  { value: "claude-opus-4.6", label: "Claude Opus 4.6" },
  { value: "claude-opus-4.5", label: "Claude Opus 4.5" },
  // OpenAI
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { value: "gpt-5-mini", label: "GPT-5 mini" },
  // Gemini
  { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
  { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
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
