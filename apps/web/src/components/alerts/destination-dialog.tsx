import type { AlertDestinationType } from "@maple/domain/http"
import { type DestinationFormState, defaultDestinationForm } from "@/lib/alerts/form-utils"
import { AlertSegmentedSelect } from "@/components/alerts/alert-segmented-select"
import { LoaderIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Separator } from "@maple/ui/components/ui/separator"
import { Switch } from "@maple/ui/components/ui/switch"

interface DestinationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  form: DestinationFormState
  onFormChange: (updater: (current: DestinationFormState) => DestinationFormState) => void
  isEditing: boolean
  saving: boolean
  onSave: () => void
}

const typeOptions = [
  { value: "slack" as const,     label: "Slack"     },
  { value: "pagerduty" as const, label: "PagerDuty" },
  { value: "webhook" as const,   label: "Webhook"   },
  { value: "hazel" as const,     label: "Hazel"     },
]

function SectionHeader({ step, title, description }: { step: number; title: string; description?: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground">
        {step}
      </span>
      <div className="space-y-0.5">
        <div className="text-sm font-semibold">{title}</div>
        {description && <div className="text-muted-foreground text-xs">{description}</div>}
      </div>
    </div>
  )
}

export function DestinationDialog({
  open,
  onOpenChange,
  form,
  onFormChange,
  isEditing,
  saving,
  onSave,
}: DestinationDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit destination" : "Add destination"}</DialogTitle>
          <DialogDescription>
            Reuse the same destination across alert rules and verify it with synthetic test events.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Section 1: Type */}
          {!isEditing && (
            <>
              <div className="space-y-3">
                <SectionHeader step={1} title="Type" description="Where should notifications go?" />
                <AlertSegmentedSelect<AlertDestinationType>
                  options={typeOptions}
                  value={form.type}
                  onChange={(value) => onFormChange(() => defaultDestinationForm(value))}
                  aria-label="Destination type"
                  className="pl-8"
                />
              </div>
              <Separator />
            </>
          )}

          {/* Section 2: Credentials */}
          <div className="space-y-3">
            <SectionHeader
              step={isEditing ? 1 : 2}
              title="Credentials"
              description="A friendly name plus the provider connection."
            />
            <div className="space-y-4 pl-8">
              <div className="space-y-2">
                <Label htmlFor="destination-name">Name</Label>
                <Input
                  id="destination-name"
                  value={form.name}
                  onChange={(event) => onFormChange((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Production paging"
                />
              </div>

              {form.type === "slack" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="destination-webhook">Slack webhook URL</Label>
                    <Input
                      id="destination-webhook"
                      value={form.webhookUrl}
                      onChange={(event) => onFormChange((current) => ({ ...current, webhookUrl: event.target.value }))}
                      placeholder={isEditing ? "Leave blank to keep current webhook" : "https://hooks.slack.com/services/..."}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="destination-channel">Channel label</Label>
                    <Input
                      id="destination-channel"
                      value={form.channelLabel}
                      onChange={(event) => onFormChange((current) => ({ ...current, channelLabel: event.target.value }))}
                      placeholder="#ops-alerts"
                    />
                  </div>
                </>
              )}

              {form.type === "pagerduty" && (
                <div className="space-y-2">
                  <Label htmlFor="destination-integration">Integration key</Label>
                  <Input
                    id="destination-integration"
                    value={form.integrationKey}
                    onChange={(event) => onFormChange((current) => ({ ...current, integrationKey: event.target.value }))}
                    placeholder={isEditing ? "Leave blank to keep current key" : "Routing key"}
                  />
                </div>
              )}

              {form.type === "webhook" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="destination-url">Webhook URL</Label>
                    <Input
                      id="destination-url"
                      value={form.url}
                      onChange={(event) => onFormChange((current) => ({ ...current, url: event.target.value }))}
                      placeholder={isEditing ? "Leave blank to keep current URL" : "https://example.com/maple-alerts"}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="destination-secret">Signing secret</Label>
                    <Input
                      id="destination-secret"
                      value={form.signingSecret}
                      onChange={(event) => onFormChange((current) => ({ ...current, signingSecret: event.target.value }))}
                      placeholder={isEditing ? "Leave blank to keep current secret" : "Optional HMAC secret"}
                    />
                  </div>
                </>
              )}

              {form.type === "hazel" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="destination-hazel-url">Hazel webhook URL</Label>
                    <Input
                      id="destination-hazel-url"
                      value={form.hazelWebhookUrl}
                      onChange={(event) => onFormChange((current) => ({ ...current, hazelWebhookUrl: event.target.value }))}
                      placeholder={
                        isEditing
                          ? "Leave blank to keep current URL"
                          : "https://api.hazel.io/webhooks/incoming/{webhookId}/{token}/maple"
                      }
                    />
                    <p className="text-muted-foreground text-xs">
                      Create a Maple webhook in Hazel under Settings → Integrations → Maple, then paste the URL here.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="destination-hazel-secret">Signing secret</Label>
                    <Input
                      id="destination-hazel-secret"
                      value={form.signingSecret}
                      onChange={(event) => onFormChange((current) => ({ ...current, signingSecret: event.target.value }))}
                      placeholder={isEditing ? "Leave blank to keep current secret" : "Optional HMAC secret"}
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          <Separator />

          {/* Section 3: Delivery */}
          <div className="space-y-3">
            <SectionHeader
              step={isEditing ? 2 : 3}
              title="Delivery"
              description="Pause notifications without deleting the destination."
            />
            <div className="flex items-center justify-between pl-8">
              <div>
                <div className="text-sm font-medium">Enabled</div>
                <div className="text-muted-foreground text-xs">
                  Disabled destinations stay attached to rules but won't receive notifications.
                </div>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(enabled) => onFormChange((current) => ({ ...current, enabled }))}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? <LoaderIcon size={14} className="animate-spin" /> : null}
            {isEditing ? "Save changes" : "Create destination"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
