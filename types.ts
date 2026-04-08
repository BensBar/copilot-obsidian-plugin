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

export const AVAILABLE_MODELS = [
  { value: "", label: "Default (auto)" },
  { value: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
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
