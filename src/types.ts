/** Minimal Anthropic-shaped protocol used by every chapter. */

export type TextBlock = { type: "text"; text: string };

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

export type ContentBlock = TextBlock | ToolUseBlock;

export type Message =
  | { role: "user"; content: string | ToolResultBlock[] }
  | { role: "assistant"; content: ContentBlock[] };

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type: "ephemeral" };
  deferred?: boolean;
};

export type SystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

export type CreateRequest = {
  model: string;
  max_tokens: number;
  system: string | SystemBlock[];
  tools?: ToolDefinition[];
  messages: Message[];
};

export type Usage = { input_tokens: number; output_tokens: number };

export type CreateResponse = { content: ContentBlock[]; usage?: Usage };

export type PermissionMode = "default" | "plan" | "auto" | "acceptEdits" | "bypass" | "dontAsk";

export type AgentMode = PermissionMode;

export interface LlmClient {
  messages: {
    create(request: CreateRequest): Promise<CreateResponse>;
    stream?(request: CreateRequest, onText: (chunk: string) => void): Promise<CreateResponse>;
  };
}
