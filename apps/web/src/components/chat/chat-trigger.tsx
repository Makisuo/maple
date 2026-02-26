import { useEffect } from "react"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { Button } from "@maple/ui/components/ui/button"

export function ChatTrigger() {
  const navigate = useNavigate()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault()
        navigate({ to: "/chat" })
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [navigate])

  if (pathname.startsWith("/chat")) return null

  return (
    <Button
      onClick={() => navigate({ to: "/chat" })}
      size="icon"
      className="fixed bottom-5 right-5 z-50 size-10 rounded-full shadow-lg"
      title={`Open Maple AI (${navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}+.)`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-5"
      >
        <path d="M12 3c-4.97 0-9 3.58-9 8 0 2.2 1.01 4.18 2.63 5.6L4.5 20.5l4.09-1.64A10.3 10.3 0 0 0 12 19.5c4.97 0 9-3.58 9-8s-4.03-8-9-8Z" />
        <path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" />
      </svg>
    </Button>
  )
}
