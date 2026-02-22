import type { ReactNode } from "react"

export function AuthLayout({
  children,
  maxWidth = "max-w-sm",
}: {
  children: ReactNode
  maxWidth?: string
}) {
  return (
    <main className="relative min-h-screen flex flex-col items-center justify-center p-6 overflow-hidden">
      {/* Grid pattern — stronger lines, radial fade */}
      <div
        className="absolute inset-0 -z-10 pointer-events-none"
        style={{
          backgroundImage: [
            "linear-gradient(to right, oklch(1 0 0 / 8%) 1px, transparent 1px)",
            "linear-gradient(to bottom, oklch(1 0 0 / 8%) 1px, transparent 1px)",
          ].join(", "),
          backgroundSize: "60px 60px",
          maskImage:
            "radial-gradient(ellipse 70% 60% at 50% 40%, black, transparent)",
        }}
      />

      {/* Accent glow — centered behind the card area */}
      <div
        className="absolute -z-10 pointer-events-none"
        style={{
          width: "600px",
          height: "400px",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          background:
            "radial-gradient(ellipse at center, oklch(0.68 0.15 237 / 0.12) 0%, oklch(0.68 0.15 237 / 0.04) 40%, transparent 70%)",
        }}
      />

      <p className="mb-6 text-lg font-semibold tracking-tight text-foreground">
        maple
      </p>
      <div
        className={`relative w-full ${maxWidth} border border-border bg-card p-6`}
      >
        {children}
      </div>
    </main>
  )
}
