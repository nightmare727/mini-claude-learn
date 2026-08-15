import type {
  ContentBlock,
  CreateRequest,
  CreateResponse,
  LlmClient,
  Message,
} from "./types.js";

export type MockTurn = {
  text?: string;
  tools?: { name: string; input: Record<string, unknown> }[];
};

export type MockTrack = {
  match?: string;
  turns: MockTurn[];
};

export type MockClient = LlmClient & {
  lastSystem: string;
  lastFirstUser: string;
  tracksUsed: string[];
};

export function createMockClient(options?: {
  tracks?: Record<string, MockTrack>;
}): MockClient {
  const tracks = options?.tracks;
  const counters: Record<string, number> = {};
  const used = new Set<string>();
  const state: MockClient = {
    lastSystem: "",
    lastFirstUser: "",
    tracksUsed: [],
    messages: {
      async create(request: CreateRequest): Promise<CreateResponse> {
        return reply(request);
      },
      async stream(request: CreateRequest, onText: (chunk: string) => void): Promise<CreateResponse> {
        const response = reply(request);
        for (const block of response.content) {
          if (block.type !== "text") continue;
          for (let i = 0; i < block.text.length; i += 24) {
            onText(block.text.slice(i, i + 24));
          }
        }
        return response;
      },
    },
  };

  function reply(request: CreateRequest): CreateResponse {
    const system = flattenSystem(request.system);
    const firstUser = firstUserText(request.messages);
    state.lastSystem = system;
    state.lastFirstUser = firstUser;

    if (tracks) {
      const track = routeTrack(system, tracks);
      used.add(track);
      state.tracksUsed = [...used];
      const index = counters[track] || 0;
      const turn = tracks[track]?.turns[index];
      if (!turn) {
        throw new Error(`mock track "${track}" has no turn ${index}`);
      }
      counters[track] = index + 1;
      return { content: contentFromTurn(turn, index) };
    }

    return { content: heuristicReply(request.messages, system) };
  }

  return state;
}

function routeTrack(system: string, tracks: Record<string, MockTrack>): string {
  const hits = Object.entries(tracks).filter(([name, t]) => name !== "main" && t.match && system.includes(t.match));
  if (hits.length > 1) throw new Error(`request matched multiple tracks: ${hits.map(([n]) => n).join(", ")}`);
  return hits[0]?.[0] ?? "main";
}

function contentFromTurn(turn: MockTurn, index: number): ContentBlock[] {
  const content: ContentBlock[] = [];
  if (turn.text) content.push({ type: "text", text: turn.text });
  (turn.tools || []).forEach((t, j) => {
    content.push({
      type: "tool_use",
      id: `toolu_mock_${index}_${j}`,
      name: t.name,
      input: t.input ?? {},
    });
  });
  return content.length ? content : [{ type: "text", text: "" }];
}

function heuristicReply(messages: Message[], system: string): ContentBlock[] {
  if (system.includes("Summarize the conversation")) {
    return [{ type: "text", text: "Earlier turns read files and ran tools." }];
  }
  if (system.includes("goal evaluator")) {
    return [{ type: "text", text: "MET" }];
  }
  if (system.includes("security monitor")) {
    return [{ type: "text", text: "ALLOW" }];
  }
  if (system.includes("explore sub-agent")) {
    return heuristicExplore(messages);
  }

  const last = messages[messages.length - 1];
  if (!last) return [{ type: "text", text: "(empty)" }];

  if (last.role === "user" && Array.isArray(last.content)) {
    return [{ type: "text", text: replyAfterTools(messages, last.content.map((b) => b.content).join("\n")) }];
  }

  const userText = last.role === "user" && typeof last.content === "string" ? last.content : "";

  if (/sub-agent|subagent/i.test(userText)) {
    return [
      {
        type: "tool_use",
        id: "toolu_mock_1",
        name: "agent",
        input: { task: "Read greeting.txt and report its contents." },
      },
    ];
  }

  if (/add tool|compute \d+\s*\+\s*\d+/i.test(userText)) {
    const nums = userText.match(/(\d+)\s*\+\s*(\d+)/);
    return [
      {
        type: "tool_use",
        id: "toolu_mock_1",
        name: "mcp__demo__add",
        input: { a: Number(nums?.[1] ?? 17), b: Number(nums?.[2] ?? 25) },
      },
    ];
  }

  if (/rm\s+-rf|delete everything/i.test(userText)) {
    return [
      { type: "text", text: "I'll remove it." },
      {
        type: "tool_use",
        id: "toolu_mock_1",
        name: "run_shell",
        input: { command: "rm -rf /tmp/demo" },
      },
    ];
  }

  const created = parseCreateFile(userText);
  if (created) {
    return [
      { type: "text", text: "I'll create the file." },
      {
        type: "tool_use",
        id: "toolu_mock_1",
        name: "write_file",
        input: { file_path: created.filePath, content: created.content },
      },
    ];
  }

  if (/read \w+\.txt,\s*then/i.test(userText)) {
    const files = userText.match(/[a-z]\.txt/gi) || [];
    const already = assistantToolCount(messages);
    const next = files[already];
    if (next) {
      return [{ type: "tool_use", id: `toolu_mock_${already}`, name: "read_file", input: { file_path: next } }];
    }
    return [{ type: "text", text: "All requested files have been read." }];
  }

  const readPath = parseReadFile(userText);
  if (readPath) {
    return [
      {
        type: "tool_use",
        id: "toolu_mock_1",
        name: "read_file",
        input: { file_path: readPath },
      },
    ];
  }

  return [{ type: "text", text: chatReply(userText) }];
}

function heuristicExplore(messages: Message[]): ContentBlock[] {
  const last = messages[messages.length - 1];
  if (last?.role === "user" && Array.isArray(last.content)) {
    const body = last.content.map((b) => b.content).join("\n");
    return [{ type: "text", text: `greeting.txt contains: ${stripLineNumbers(body).trim()}` }];
  }
  return [
    {
      type: "tool_use",
      id: "toolu_sub_1",
      name: "read_file",
      input: { file_path: "greeting.txt" },
    },
  ];
}

function replyAfterTools(messages: Message[], toolOutput: string): string {
  const lastTool = lastAssistantToolName(messages);
  if (lastTool === "write_file") {
    return `Created ${lastAssistantFilePath(messages) ?? "notes.txt"}.`;
  }
  if (lastTool === "run_shell") {
    return toolOutput.startsWith("Denied")
      ? "That was blocked by the permission system, so nothing was deleted."
      : "Command finished.";
  }
  if (lastTool === "agent") {
    return `The sub-agent reports ${toolOutput}`;
  }
  if (lastTool?.startsWith("mcp__")) {
    return `${lastTool} returned ${toolOutput}.`;
  }
  const filePath = lastAssistantFilePath(messages) ?? "the file";
  return `${filePath} says: ${stripLineNumbers(toolOutput).trim()}`;
}

function lastAssistantToolName(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const tool = message.content.find((block) => block.type === "tool_use");
    return tool?.type === "tool_use" ? tool.name : undefined;
  }
  return undefined;
}

function lastAssistantFilePath(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const tool = message.content.find((block) => block.type === "tool_use");
    if (tool?.type === "tool_use" && typeof tool.input.file_path === "string") {
      return tool.input.file_path;
    }
  }
  return undefined;
}

function assistantToolCount(messages: Message[]): number {
  return messages.filter((m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use")).length;
}

function flattenSystem(system: CreateRequest["system"]): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((block) => block.text).join("");
  return "";
}

function firstUserText(messages: Message[]): string {
  const first = messages.find((m) => m.role === "user");
  return first && typeof first.content === "string" ? first.content : "";
}

function parseCreateFile(text: string): { filePath: string; content: string } | undefined {
  const match =
    text.match(/create a file\s+(\S+)\s+containing(?: the text)?\s+(.+?)\.?$/i) ||
    text.match(/创建(?:一个)?文件\s+(\S+)\s*(?:内容(?:是|为)?|containing)?\s*(.+)?$/i);
  if (!match) return undefined;
  return { filePath: match[1], content: (match[2] || "ok").replace(/\.$/, "") };
}

function parseReadFile(text: string): string | undefined {
  const explicit =
    text.match(/(?:read(?: the file)?|打开|读取?|看看)\s+([\w./-]+\.\w+)/i) ||
    text.match(/([\w./-]+\.\w+)\s*(?:是什么|里写了什么|内容)/);
  if (explicit) return explicit[1];
  if (!/(?:read|读取?|打开|看看)/i.test(text)) return undefined;
  return extractFilePath(text);
}

function extractFilePath(text: string): string | undefined {
  return text.match(/([\w./-]+\.\w+)/)?.[1];
}

function chatReply(text: string): string {
  if (/你是(谁|什么)|what (are you|model)|which model|什么模型/i.test(text)) {
    return (
      "我是 Mini Claude Code，本地教学用的 agent 外壳，不是云端大模型。\n" +
      "当前后端是 mock：普通聊天直接回话；你让我读/写文件或跑命令时才会走工具循环。\n" +
      "可以试试：Read fixtures/greeting.txt and tell me what it says."
    );
  }
  if (/^(hi|hello|hey|你好|哈喽)\b/i.test(text.trim())) {
    return "你好。我是本地 mock 的 Mini Claude。想看工具循环，让我读或写一个文件就行。";
  }
  return (
    "收到。我这边还是本地 mock，不会真正推理。\n" +
    "要演示工具循环，可以说：Read fixtures/greeting.txt and tell me what it says."
  );
}

function stripLineNumbers(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\s+\|\s?/, ""))
    .join("\n");
}
