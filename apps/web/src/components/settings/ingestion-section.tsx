import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { useMemo, useState } from "react"
import { Exit } from "effect"
import { toast } from "sonner"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@maple/ui/components/ui/card"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@maple/ui/components/ui/alert-dialog"
import { Badge } from "@maple/ui/components/ui/badge"
import { Separator } from "@maple/ui/components/ui/separator"
import {
  AlertWarningIcon,
  CheckIcon,
  CopyIcon,
  EyeIcon,
  ShieldIcon,
} from "@/components/icons"
import { ingestUrl } from "@/lib/services/common/ingest-url"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

function maskKey(key: string): string {
  if (key.length <= 18) return key
  const prefix = key.slice(0, 14)
  const suffix = key.slice(-4)
  return `${prefix}${"•".repeat(key.length - 18)}${suffix}`
}

interface ApiKeyRowProps {
  type: "public" | "private"
  label: string
  description: string
  keyValue: string
  isVisible: boolean
  onToggleVisibility: () => void
  isCopied: boolean
  onCopy: () => void
  onRegenerate: () => void
  disabled: boolean
}

function ApiKeyRow({
  type,
  label,
  description,
  keyValue,
  isVisible,
  onToggleVisibility,
  isCopied,
  onCopy,
  onRegenerate,
  disabled,
}: ApiKeyRowProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Badge variant={type === "private" ? "outline" : "secondary"}>
          {type === "private" && <ShieldIcon size={12} />}
          {label}
        </Badge>
        <span className="text-muted-foreground text-xs">{description}</span>
      </div>

      <InputGroup>
        <InputGroupInput
          readOnly
          value={isVisible ? keyValue : maskKey(keyValue)}
          className="font-mono text-xs tracking-wide select-all"
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            onClick={onToggleVisibility}
            aria-label={isVisible ? "Hide key" : "Reveal key"}
            title={isVisible ? "Hide" : "Reveal"}
            disabled={disabled}
          >
            <EyeIcon
              size={14}
              className={isVisible ? "text-foreground" : undefined}
            />
          </InputGroupButton>

          <InputGroupButton
            onClick={onCopy}
            aria-label="Copy key to clipboard"
            title={isCopied ? "Copied!" : "Copy"}
            disabled={disabled}
          >
            {isCopied ? (
              <CheckIcon size={14} className="text-emerald-500" />
            ) : (
              <CopyIcon size={14} />
            )}
          </InputGroupButton>

          <InputGroupButton
            onClick={onRegenerate}
            aria-label="Regenerate key"
            title="Regenerate"
            className="text-destructive hover:text-destructive"
            disabled={disabled}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width={14}
              height={14}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 16h5v5" />
            </svg>
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

export function IngestionSection() {
  const [publicKeyVisible, setPublicKeyVisible] = useState(false)
  const [privateKeyVisible, setPrivateKeyVisible] = useState(false)
  const [copiedKey, setCopiedKey] = useState<"public" | "private" | null>(null)
  const [regenerateDialogOpen, setRegenerateDialogOpen] = useState(false)
  const [regenerateKeyType, setRegenerateKeyType] = useState<
    "public" | "private" | null
  >(null)
  const [submittingKeyType, setSubmittingKeyType] = useState<
    "public" | "private" | null
  >(null)
  const [endpointCopied, setEndpointCopied] = useState(false)

  const keysQueryAtom = MapleApiAtomClient.query("ingestKeys", "get", {})
  const keysResult = useAtomValue(keysQueryAtom)
  const refreshKeys = useAtomRefresh(keysQueryAtom)

  const rerollPublicMutation = useAtomSet(
    MapleApiAtomClient.mutation("ingestKeys", "rerollPublic"),
    { mode: "promiseExit" },
  )
  const rerollPrivateMutation = useAtomSet(
    MapleApiAtomClient.mutation("ingestKeys", "rerollPrivate"),
    { mode: "promiseExit" },
  )

  const isBusy = useMemo(
    () => !Result.isSuccess(keysResult) || submittingKeyType !== null,
    [keysResult, submittingKeyType],
  )

  async function handleCopy(keyType: "public" | "private") {
    if (!Result.isSuccess(keysResult)) return

    const key =
      keyType === "public"
        ? keysResult.value.publicKey
        : keysResult.value.privateKey

    try {
      await navigator.clipboard.writeText(key)
      setCopiedKey(keyType)
      toast.success("Ingest key copied to clipboard")
      setTimeout(() => {
        setCopiedKey((current) => (current === keyType ? null : current))
      }, 2000)
    } catch {
      toast.error("Failed to copy ingest key")
    }
  }

  async function handleCopyEndpoint() {
    try {
      await navigator.clipboard.writeText(ingestUrl)
      setEndpointCopied(true)
      toast.success("Ingest endpoint copied to clipboard")
      setTimeout(() => setEndpointCopied(false), 2000)
    } catch {
      toast.error("Failed to copy endpoint")
    }
  }

  function openRegenerateDialog(keyType: "public" | "private") {
    setRegenerateKeyType(keyType)
    setRegenerateDialogOpen(true)
  }

  async function handleRegenerate() {
    if (!regenerateKeyType) return

    setSubmittingKeyType(regenerateKeyType)

    const result =
      regenerateKeyType === "public"
        ? await rerollPublicMutation({})
        : await rerollPrivateMutation({})

    if (Exit.isSuccess(result)) {
      refreshKeys()
      setCopiedKey(null)

      toast.success(
        `${regenerateKeyType === "public" ? "Public" : "Private"} key regenerated. Previous key was revoked immediately.`,
      )
    } else {
      toast.error("Unable to complete request")
    }

    setSubmittingKeyType(null)
    setRegenerateDialogOpen(false)
    setRegenerateKeyType(null)
  }

  const publicKey = Result.builder(keysResult)
    .onSuccess((v) => v.publicKey)
    .orElse(() => "Loading...")
  const privateKey = Result.builder(keysResult)
    .onSuccess((v) => v.privateKey)
    .orElse(() => "Loading...")

  return (
    <>
      <div className="max-w-2xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Ingest Endpoint</CardTitle>
            <CardDescription>
              Send your OpenTelemetry data to this endpoint.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <InputGroup>
              <InputGroupInput
                readOnly
                value={ingestUrl}
                className="font-mono text-xs tracking-wide select-all"
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  onClick={handleCopyEndpoint}
                  aria-label="Copy endpoint to clipboard"
                  title={endpointCopied ? "Copied!" : "Copy"}
                >
                  {endpointCopied ? (
                    <CheckIcon size={14} className="text-emerald-500" />
                  ) : (
                    <CopyIcon size={14} />
                  )}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <p className="text-muted-foreground text-xs">
              Learn how to send telemetry data in the{" "}
              <a
                href="https://docs.maple.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline underline-offset-2 hover:no-underline"
              >
                documentation
              </a>
              .
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Ingest Keys</CardTitle>
            <CardDescription>
              Use these keys to authenticate telemetry ingestion. The public key
              is safe for client-side use. Keep your private key secret and never
              expose it in frontend code.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ApiKeyRow
              type="public"
              label="Public"
              description="For browser and client-side telemetry SDKs"
              keyValue={publicKey}
              isVisible={publicKeyVisible}
              onToggleVisibility={() => setPublicKeyVisible((v) => !v)}
              isCopied={copiedKey === "public"}
              onCopy={() => handleCopy("public")}
              onRegenerate={() => openRegenerateDialog("public")}
              disabled={isBusy}
            />
            <Separator />
            <ApiKeyRow
              type="private"
              label="Private"
              description="For server-side ingestion and backend services"
              keyValue={privateKey}
              isVisible={privateKeyVisible}
              onToggleVisibility={() => setPrivateKeyVisible((v) => !v)}
              isCopied={copiedKey === "private"}
              onCopy={() => handleCopy("private")}
              onRegenerate={() => openRegenerateDialog("private")}
              disabled={isBusy}
            />
          </CardContent>
        </Card>
      </div>

      <AlertDialog
        open={regenerateDialogOpen}
        onOpenChange={setRegenerateDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <AlertWarningIcon className="text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>
              Regenerate {regenerateKeyType === "public" ? "public" : "private"}{" "}
              key?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. All existing integrations using this
              key will stop working immediately. You will need to update your{" "}
              {regenerateKeyType === "public"
                ? "client-side SDKs"
                : "server configurations"}{" "}
              with the new key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submittingKeyType !== null}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleRegenerate}
              disabled={submittingKeyType !== null}
            >
              Regenerate key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
