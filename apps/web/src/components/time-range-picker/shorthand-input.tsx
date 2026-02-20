import { useState, useCallback } from "react"
import { Input } from "@maple/ui/components/ui/input"
import { relativeToAbsolute } from "@/lib/time-utils"

interface ShorthandInputProps {
  onApply: (range: { startTime: string; endTime: string }, value: string, label: string) => void
}

export function ShorthandInput({ onApply }: ShorthandInputProps) {
  const [value, setValue] = useState("")
  const [error, setError] = useState(false)

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        const range = relativeToAbsolute(value)
        if (range) {
          onApply(range, value.toLowerCase(), `Last ${value.toLowerCase()}`)
          setValue("")
          setError(false)
        } else {
          setError(true)
        }
      }
    },
    [value, onApply]
  )

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value)
    setError(false)
  }, [])

  return (
    <div className="space-y-1">
      <Input
        placeholder="1m or 2h or 4d"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        className={error ? "border-destructive" : ""}
      />
      {error && (
        <p className="text-xs text-destructive">
          Invalid format. Use: 5m, 2h, 4d, 1w, 2mo, or today
        </p>
      )}
    </div>
  )
}
