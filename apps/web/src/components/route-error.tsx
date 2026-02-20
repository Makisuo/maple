import type { ErrorComponentProps } from "@tanstack/react-router"
import { Link, useRouter } from "@tanstack/react-router"
import { AlertWarningIcon, CircleQuestionIcon, HouseIcon } from "@/components/icons"
import { Button, buttonVariants } from "@maple/ui/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@maple/ui/components/ui/empty"

function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter()

  const message =
    error instanceof Error ? error.message : "An unexpected error occurred"
  const stack = error instanceof Error ? error.stack : undefined

  return (
    <Empty className="min-h-[60vh]">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-destructive/10 text-destructive">
          <AlertWarningIcon size={18} />
        </EmptyMedia>
        <EmptyTitle>Something went wrong</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="default"
          onClick={() => {
            reset()
            router.invalidate()
          }}
        >
          Try again
        </Button>
        <Link to="/" className={buttonVariants({ size: "sm", variant: "outline" })}>
          <HouseIcon size={14} />
          Go home
        </Link>
      </div>
      {import.meta.env.DEV && stack && (
        <details className="mt-4 w-full max-w-2xl text-left">
          <summary className="text-muted-foreground cursor-pointer text-xs select-none">
            Stack trace
          </summary>
          <pre className="bg-muted mt-2 overflow-auto p-3 font-mono text-[11px] leading-relaxed">
            {stack}
          </pre>
        </details>
      )}
    </Empty>
  )
}

function NotFoundError() {
  return (
    <Empty className="min-h-[60vh]">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CircleQuestionIcon size={18} />
        </EmptyMedia>
        <EmptyTitle>Page not found</EmptyTitle>
        <EmptyDescription>
          The page you're looking for doesn't exist or has been moved.
        </EmptyDescription>
      </EmptyHeader>
      <div className="mt-2">
        <Link to="/" className={buttonVariants({ size: "sm", variant: "outline" })}>
          <HouseIcon size={14} />
          Go home
        </Link>
      </div>
    </Empty>
  )
}

export { RouteError, NotFoundError }
