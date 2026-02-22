import { dark } from "@clerk/themes"

export const clerkAppearance = {
  baseTheme: dark,
  variables: {
    colorBackground: "oklch(0.21 0.006 285.885)",
    colorInputBackground: "oklch(0.18 0.005 285.85)",
    colorText: "oklch(0.985 0 0)",
    colorTextSecondary: "oklch(0.705 0.015 286.067)",
    colorPrimary: "oklch(0.68 0.15 237)",
    colorDanger: "oklch(0.704 0.191 22.216)",
    colorInputText: "oklch(0.985 0 0)",
    borderRadius: "0px",
    fontFamily: "'Geist Mono Variable', monospace",
  },
  elements: {
    cardBox: "bg-transparent shadow-none border-none",
    card: "bg-transparent shadow-none border-none p-0",
    headerTitle: "text-foreground",
    headerSubtitle: "text-muted-foreground",
    socialButtonsBlockButton:
      "border-border bg-transparent text-foreground hover:bg-muted",
    formFieldLabel: "text-foreground",
    formFieldInput: "border-border bg-input text-foreground",
    footerActionLink: "text-primary",
    dividerLine: "bg-border",
    dividerText: "text-muted-foreground",
    formButtonPrimary: "bg-primary text-primary-foreground hover:opacity-90",
    footer: "text-muted-foreground [&_a]:text-primary",
  },
}
