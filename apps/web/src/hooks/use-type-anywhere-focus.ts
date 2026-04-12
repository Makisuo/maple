import { useEffect, type RefObject } from "react"

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"])

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (EDITABLE_TAGS.has(target.tagName)) return true
  if (target.isContentEditable) return true
  return false
}

function isDialogOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"]') !== null
}

function insertCharIntoTextarea(textarea: HTMLTextAreaElement, char: string): void {
  const start = textarea.selectionStart ?? textarea.value.length
  const end = textarea.selectionEnd ?? textarea.value.length
  const nextValue = textarea.value.slice(0, start) + char + textarea.value.slice(end)

  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set
  setter?.call(textarea, nextValue)

  const caret = start + char.length
  textarea.setSelectionRange(caret, caret)
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
}

export function useTypeAnywhereFocus(
  ref: RefObject<HTMLTextAreaElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return

    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key.length !== 1) return
      if (isEditableTarget(e.target)) return
      if (isDialogOpen()) return

      const textarea = ref.current
      if (!textarea || textarea.disabled) return

      e.preventDefault()
      textarea.focus()
      insertCharIntoTextarea(textarea, e.key)
    }

    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [ref, enabled])
}
