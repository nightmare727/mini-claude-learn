#!/usr/bin/env node
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "demo", version: "1.0" },
      },
    });
  } else if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "add",
            description: "Add two numbers and return the sum.",
            inputSchema: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "number" } },
              required: ["a", "b"],
            },
          },
        ],
      },
    });
  } else if (method === "tools/call") {
    if (params?.name === "add") {
      const sum = (params.arguments?.a ?? 0) + (params.arguments?.b ?? 0);
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(sum) }] } });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${params?.name}` } });
    }
  }
});
