export type Frontmatter = { meta: Record<string, string>; body: string };

export function parseFrontmatter(raw: string): Frontmatter {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return { meta: {}, body: raw };

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { meta: {}, body: raw };

  const meta: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const colon = lines[i].indexOf(":");
    if (colon < 1) continue;
    const key = lines[i].slice(0, colon).trim();
    if (key) meta[key] = lines[i].slice(colon + 1).trim();
  }
  return { meta, body: lines.slice(endIdx + 1).join("\n").trim() };
}

export function formatFrontmatter(meta: Record<string, string>, body: string): string {
  const lines = Object.entries(meta).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n${body.trim()}\n`;
}
