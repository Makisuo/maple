import { type DestinationFormState, defaultDestinationForm } from "@/lib/alerts/form-utils"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@maple/ui/components/ui/select"
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
          <DialogTitle>{isEditing ? "Edit Destination" : "Add Destination"}</DialogTitle>
          <DialogDescription>
            Reuse the same destination across multiple alert rules and verify it with synthetic test events.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!isEditing && (
            <div className="space-y-2">
              <Label htmlFor="destination-type">Type</Label>
              <Select
                value={form.type}
                onValueChange={(value) => {
                  if (!value) return
                  onFormChange(() => defaultDestinationForm(value))
                }}
              >
                <SelectTrigger id="destination-type">
                  <SelectValue placeholder="Select destination type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="slack">Slack</SelectItem>
                  <SelectItem value="pagerduty">PagerDuty</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

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

          <div className="flex items-center justify-between rounded-lg border px-3 py-2">
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

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? <LoaderIcon size={14} className="animate-spin" /> : null}
            {isEditing ? "Save Changes" : "Create Destination"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
