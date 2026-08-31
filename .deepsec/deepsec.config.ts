import { generatedMatchersPlugin } from "./generated-matchers.js";
import { defineConfig } from "deepsec/config"

export default defineConfig({
  defaultModel: "gpt-5.6-sol", // <deepsec:default-model>
  defaultAgent: "codex", // <deepsec:default-agent>
  ai: {"mode":"local","provider":"local"}, // <deepsec:model-route>
  plugins: [generatedMatchersPlugin],
  projects: [
		{ id: "maple", root: ".." },
		// <deepsec:projects-insert-above>
	],
})
