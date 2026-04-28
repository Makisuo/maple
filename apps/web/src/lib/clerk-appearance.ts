import { dark } from "@clerk/themes"

export const clerkAppearance = {
	baseTheme: dark,
	variables: {
		colorBackground: "oklch(0.207 0.008 67)",
		colorInputBackground: "oklch(0.33 0.015 72)",
		colorText: "oklch(0.91 0.016 74)",
		colorTextSecondary: "oklch(0.603 0.023 72)",
		colorPrimary: "oklch(0.714 0.154 59)",
		colorDanger: "oklch(0.654 0.176 30)",
		colorInputText: "oklch(0.91 0.016 74)",
		borderRadius: "0px",
		fontFamily: "'Geist Mono Variable', monospace",
	},
	elements: {
		cardBox: "bg-transparent shadow-none border-none",
		card: "bg-transparent shadow-none border-none p-0",
		headerTitle: "text-foreground",
		headerSubtitle: "text-muted-foreground",
		socialButtonsBlockButton: "border-border bg-transparent text-foreground hover:bg-muted",
		formFieldLabel: "text-foreground",
		formFieldInput: "border-border bg-input text-foreground",
		footerActionLink: "text-primary",
		dividerLine: "bg-border",
		dividerText: "text-muted-foreground",
		formButtonPrimary: "bg-primary text-primary-foreground hover:opacity-90",
		footer: "text-muted-foreground [&_a]:text-primary",
	},
}
