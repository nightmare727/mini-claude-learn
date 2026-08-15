import { createMockClient } from "./mock-client.js";
import type { ContentBlock, CreateRequest, CreateResponse, LlmClient, Message, ToolUseBlock } from "./types.js";

export type LlmKind = "mock" | "anthropic" | "openai";

export type ResolvedLlm = {
  kind: LlmKind;
  label: string;
  client: LlmClient;
};

export function resolveLlm(forceMock = false): ResolvedLlm {
  if (forceMock) {
    return { kind: "mock", label: "mock (forced)", client: createMockClient() };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
    const model = process.env.MINI_MODEL || "grok-4.6";
    return {
      kind: "anthropic",
      label: `anthropic ${model} @ ${base}`,
      client: createAnthropicClient(process.env.ANTHROPIC_API_KEY, base),
    };
  }
  if (process.env.OPENAI_API_KEY) {
    const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const model = process.env.MINI_MODEL || "gpt-4o";
    return {
      kind: "openai",
      label: `openai-compat ${model} @ ${base}`,
      client: createOpenAiClient(process.env.OPENAI_API_KEY, base),
    };
  }
  return { kind: "mock", label: "mock (no API key)", client: createMockClient() };
}

function createAnthropicClient(apiKey: string, baseUrl: string): LlmClient {
  return {
    messages: {
      create: (request) => anthropicRequest(apiKey, baseUrl, request, false),
      stream: (request, onText) => anthropicRequest(apiKey, baseUrl, request, true, onText),
    },
  };
}

async function anthropicRequest(
  apiKey: string,
  baseUrl: string,
  request: CreateRequest,
  stream: boolean,
  onText?: (chunk: string) => void,
): Promise<CreateResponse> {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: request.max_tokens,
      system: request.system,
      tools: request.tools,
      messages: request.messages,
      stream,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 500)}`);
  }
  if (!stream) {
    const data = (await res.json()) as {
      content: ContentBlock[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      content: (data.content || []).map(normalizeAnthropicBlock),
      usage: {
        input_tokens: data.usage?.input_tokens || 0,
        output_tokens: data.usage?.output_tokens || 0,
      },
    };
  }
  return readAnthropicSse(res, onText ?? (() => undefined));
}

function normalizeAnthropicBlock(block: any): ContentBlock {
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: String(block.id),
      name: String(block.name),
      input: (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>,
    };
  }
  return { type: "text", text: String(block.text ?? "") };
}

async function readAnthropicSse(
  res: Response,
  onText: (chunk: string) => void,
): Promise<CreateResponse> {
  if (!res.body) throw new Error("Anthropic stream had no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const blocks: ContentBlock[] = [];
  const jsonBuf: string[] = [];
  let leftover = "";

  const applyEvent = (event: string, data: any) => {
    if (event === "content_block_start") {
      const index = data.index as number;
      const block = data.content_block;
      blocks[index] =
        block.type === "tool_use"
          ? { type: "tool_use", id: block.id, name: block.name, input: {} }
          : { type: "text", text: block.text ?? "" };
      jsonBuf[index] = "";
    } else if (event === "content_block_delta") {
      const index = data.index as number;
      const delta = data.delta;
      if (delta.type === "text_delta") {
        const text = String(delta.text ?? "");
        const current = blocks[index];
        if (current?.type === "text") current.text += text;
        else blocks[index] = { type: "text", text };
        onText(text);
      } else if (delta.type === "input_json_delta") {
        jsonBuf[index] = (jsonBuf[index] || "") + String(delta.partial_json ?? "");
      }
    } else if (event === "content_block_stop") {
      const index = data.index as number;
      const current = blocks[index];
      if (current?.type === "tool_use" && jsonBuf[index]) {
        try {
          current.input = JSON.parse(jsonBuf[index]) as Record<string, unknown>;
        } catch {
          current.input = {};
        }
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    leftover += decoder.decode(value || new Uint8Array(), { stream: !done });
    const parts = leftover.split("\n\n");
    leftover = done ? "" : parts.pop() || "";
    for (const part of parts) {
      let event = "";
      let dataLine = "";
      for (const line of part.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) dataLine += line.slice(5).trim();
      }
      if (!dataLine) continue;
      let data: any;
      try {
        data = JSON.parse(dataLine);
      } catch {
        continue;
      }
      applyEvent(event || data.type, data);
    }
    if (done) break;
  }
  return { content: blocks.filter(Boolean) };
}

function createOpenAiClient(apiKey: string, baseUrl: string): LlmClient {
  return {
    messages: {
      async create(request) {
        return openAiRequest(apiKey, baseUrl, request, false);
      },
      async stream(request, onText) {
        return openAiRequest(apiKey, baseUrl, request, true, onText);
      },
    },
  };
}

async function openAiRequest(
  apiKey: string,
  baseUrl: string,
  request: CreateRequest,
  stream: boolean,
  onText?: (chunk: string) => void,
): Promise<CreateResponse> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: request.max_tokens,
      stream,
      messages: toOpenAiMessages(request.system, request.messages),
      tools: (request.tools || []).map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI-compat ${res.status}: ${body.slice(0, 500)}`);
  }
  if (!stream) {
    const data = (await res.json()) as any;
    return {
      content: fromOpenAiMessage(data.choices?.[0]?.message),
      usage: {
        input_tokens: Number(data.usage?.prompt_tokens || 0),
        output_tokens: Number(data.usage?.completion_tokens || 0),
      },
    };
  }
  return readOpenAiSse(res, onText ?? (() => undefined));
}

function flattenSystem(system: CreateRequest["system"]): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((block) => block.text).join("");
  return "";
}

function toOpenAiMessages(system: CreateRequest["system"], messages: Message[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: flattenSystem(system) }];
  for (const message of messages) {
    if (message.role === "user" && typeof message.content === "string") {
      out.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      for (const block of message.content) {
        out.push({ role: "tool", tool_call_id: block.tool_use_id, content: block.content });
      }
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls = message.content
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    }
  }
  return out;
}

function fromOpenAiMessage(message: any): ContentBlock[] {
  const content: ContentBlock[] = [];
  if (message?.content) content.push({ type: "text", text: String(message.content) });
  for (const call of message?.tool_calls || []) {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(call.function?.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({
      type: "tool_use",
      id: String(call.id),
      name: String(call.function?.name || "unknown"),
      input,
    });
  }
  return content.length ? content : [{ type: "text", text: "" }];
}

async function readOpenAiSse(res: Response, onText: (chunk: string) => void): Promise<CreateResponse> {
  if (!res.body) throw new Error("OpenAI stream had no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let leftover = "";
  let text = "";
  const tools = new Map<number, { id: string; name: string; args: string }>();

  while (true) {
    const { value, done } = await reader.read();
    leftover += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = leftover.split("\n");
    leftover = done ? "" : lines.pop() || "";
    for (const line of lines) {
      const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!payload || payload === "[DONE]") continue;
      let data: any;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = data.choices?.[0]?.delta;
      if (delta?.content) {
        text += delta.content;
        onText(delta.content);
      }
      for (const call of delta?.tool_calls || []) {
        const idx = call.index ?? 0;
        const cur = tools.get(idx) || { id: "", name: "", args: "" };
        if (call.id) cur.id = call.id;
        if (call.function?.name) cur.name = call.function.name;
        if (call.function?.arguments) cur.args += call.function.arguments;
        tools.set(idx, cur);
      }
    }
    if (done) break;
  }

  const content: ContentBlock[] = [];
  if (text) content.push({ type: "text", text });
  for (const tool of tools.values()) {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(tool.args || "{}");
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: tool.id, name: tool.name, input });
  }
  return { content: content.length ? content : [{ type: "text", text: "" }] };
}
