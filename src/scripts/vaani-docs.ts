import { mkdir, writeFile } from "node:fs/promises";
import { buildAgentInstructions, buildToolsDoc } from "../core/vaani-instructions.ts";

// Writes the two documents to paste into Vaani's dashboard.
const dir = new URL("../../docs/", import.meta.url);
await mkdir(dir, { recursive: true });
await writeFile(new URL("vaani-agent-instructions.md", dir), buildAgentInstructions());
await writeFile(new URL("vaani-tools.md", dir), buildToolsDoc(process.env.PUBLIC_BASE_URL));
console.log("wrote docs/vaani-agent-instructions.md and docs/vaani-tools.md");
