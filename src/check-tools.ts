import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool, htmlToText, listTodos, resetTodos } from "./tools.js";

const root = mkdtempSync(join(tmpdir(), "mini-claude-ch2-"));
const failures: string[] = [];

function expect(name: string, actual: unknown, check: (value: unknown) => boolean): void {
  if (check(actual)) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failures.push(name);
  console.log(`  ✗ ${name}`);
  console.log(`    got: ${String(actual).slice(0, 200)}`);
}

try {
  process.chdir(root);
  writeFileSync("dup.txt", "alpha\nalpha\n");

  const wrote = await executeTool("write_file", {
    file_path: "src/hello.ts",
    content: 'const msg = "hello";\n',
  });
  expect("write_file creates parent dirs", wrote, (v) => String(v).startsWith("Successfully wrote"));
  expect("write_file content", readFileSync("src/hello.ts", "utf-8"), (v) => v === 'const msg = "hello";\n');

  const edited = await executeTool("edit_file", {
    file_path: "src/hello.ts",
    old_string: "hello",
    new_string: "world",
  });
  expect("edit_file unique match", edited, (v) => String(v).startsWith("Successfully edited"));
  expect("edit_file applied once", readFileSync("src/hello.ts", "utf-8"), (v) => v === 'const msg = "world";\n');

  const refused = await executeTool("edit_file", {
    file_path: "dup.txt",
    old_string: "alpha",
    new_string: "beta",
  });
  expect("edit_file refuses non-unique match", refused, (v) => String(v).includes("found 2 times"));
  expect("dup.txt unchanged", readFileSync("dup.txt", "utf-8"), (v) => v === "alpha\nalpha\n");

  const listed = await executeTool("list_files", { pattern: "**/*.ts" });
  expect("list_files finds ts", listed, (v) => String(v).includes("src/hello.ts"));

  const grepped = await executeTool("grep_search", { pattern: "world", path: "." });
  expect("grep_search hits", grepped, (v) => String(v).includes("world"));

  const echoed = await executeTool("run_shell", { command: "printf ready" });
  expect("run_shell stdout", echoed, (v) => v === "ready");

  const unknown = await executeTool("not_a_tool", {});
  expect("unknown tool is data, not throw", unknown, (v) => v === "Unknown tool: not_a_tool");

  const escaped = await executeTool("list_files", { pattern: "**/*", path: "/Users/gaofei" });
  expect("list_files stays in workspace", escaped, (v) => String(v).includes("outside the workspace") || String(v).includes("Do not scan $HOME"));

  const lsHome = await executeTool("run_shell", { command: "ls /Users/gaofei" });
  expect("run_shell ls $HOME denied", lsHome, (v) => String(v).includes("Do not scan $HOME"));

  const findHome = await executeTool("run_shell", { command: "find ~ -name '*skill*'" });
  expect("run_shell find ~ denied", findHome, (v) => String(v).includes("Do not scan $HOME"));

  const quoted = await executeTool("edit_file", {
    file_path: "src/hello.ts",
    old_string: "const msg = \u201Cworld\u201D;",
    new_string: "const msg = \"ok\";",
  });
  expect("edit_file quote normalize", quoted, (v) => String(v).includes("Successfully edited"));

  resetTodos();
  const todos = await executeTool("todo_write", {
    todos: [
      { id: "1", content: "read files", status: "completed" },
      { id: "2", content: "edit", status: "in_progress" },
    ],
  });
  expect("todo_write lists items", todos, (v) => String(v).includes("[in_progress] 2: edit"));
  expect("todo state stored", listTodos().length, (v) => v === 2);

  expect("htmlToText strips tags", htmlToText("<p>Hi <b>there</b></p>"), (v) => v === "Hi there");
  const badFetch = await executeTool("web_fetch", { url: "file:///etc/passwd" });
  expect("web_fetch rejects non-http", badFetch, (v) => String(v).includes("http(s)"));
} finally {
  process.chdir(tmpdir());
  rmSync(root, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall tool checks passed");
