import { defineConfig } from "deepsec/config";

export default defineConfig({
  projects: [
    { id: "maple", root: ".." },
    // <deepsec:projects-insert-above>
  ],
});
