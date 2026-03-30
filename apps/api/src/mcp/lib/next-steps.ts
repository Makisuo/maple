export function formatNextSteps(steps: string[]): string {
  if (steps.length === 0) return ""
  return "\n\n**Suggested next steps:**\n" + steps.map((s) => `- ${s}`).join("\n")
}
