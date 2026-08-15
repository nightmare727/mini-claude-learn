import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../dist/agent.js";
import { createMockClient } from "../dist/mock-client.js";

const sandbox = mkdtempSync(join(tmpdir(), "mini-rewind-"));
const prev = process.cwd();
process.chdir(sandbox);
writeFileSync("keep.txt", "old\n");

const mock = createMockClient({
  tracks: {
    main: {
      turns: [
        { tools: [{ name: "write_file", input: { file_path: "keep.txt", content: "new\n" } }] },
        { text: "Wrote keep.txt." },
        { tools: [{ name: "write_file", input: { file_path: "extra.txt", content: "bonus\n" } }] },
        { text: "Wrote extra.txt." },
        { text: "Done." },
      ],
    },
    compact: {
      match: "Summarize the conversation",
      turns: [{ text: "User overwrote keep.txt then created extra.txt." }],
    },
  },
});

const agent = new Agent(mock);
const fail = (name) => {
  console.error(`FAIL ${name}`);
  process.exitCode = 1;
};
const ok = (name) => console.log(`OK   ${name}`);

try {
  await agent.chat("overwrite keep.txt");
  await agent.chat("create extra.txt");

  const afterKeep = readFileSync("keep.txt", "utf-8");
  const extraExists = existsSync("extra.txt");
  console.log(`after turns: keep.txt=${JSON.stringify(afterKeep)} extra=${extraExists}`);
  afterKeep === "new\n" ? ok("keep overwritten") : fail("keep overwritten");
  extraExists ? ok("extra created") : fail("extra created");

  const result = agent.rewindTo(1);
  console.log(`rewind prompt: ${result.prompt}`);
  console.log(`restored=${result.files.restored.join(",") || "-"} deleted=${result.files.deleted.join(",") || "-"}`);

  const restoredKeep = readFileSync("keep.txt", "utf-8");
  console.log(`after rewind: keep.txt=${JSON.stringify(restoredKeep)} extra=${existsSync("extra.txt")}`);
  restoredKeep === "old\n" ? ok("keep restored to old") : fail("keep restored to old");
  !existsSync("extra.txt") ? ok("extra deleted") : fail("extra deleted");
  !JSON.stringify(agent.history()).includes("create extra.txt") ? ok("later turn dropped") : fail("later turn dropped");
  agent.rewindPoints().length === 0 ? ok("rewind points cleared") : fail("rewind points cleared");
} finally {
  process.chdir(prev);
  rmSync(sandbox, { recursive: true, force: true });
}
