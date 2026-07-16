import { useAtomSet } from "@/lib/effect-atom"
import { useState } from "react"
import { Exit } from "effect"
import type { V2ApiKey } from "@maple/domain/http/v2"
import { toast } from "sonner"

import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { useApiKeyMutationSync } from "@/hooks/use-api-keys"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { ApiKeySecretReveal } from "./api-key-secret-reveal"

interface RollApiKeyDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	apiKey: V2ApiKey | null
	onRolled?: () => void
}

export function RollApiKeyDialog({ open, onOpenChange, apiKey, onRolled }: RollApiKeyDialogProps) {
	const [isRolling, setIsRolling] = useState(false)
	const [newSecret, setNewSecret] = useState<string | null>(null)

	const { prepareForMutation, reconcileTxid } = useApiKeyMutationSync()
	const rollMutation = useAtomSet(MapleApiV2AtomClient.mutation("apiKeys", "roll"), {
		mode: "promiseExit",
	})

	async function handleRoll() {
		if (!apiKey) return
		setIsRolling(true)
		prepareForMutation()
		const result = await rollMutation({ params: { id: apiKey.id } })
		if (Exit.isSuccess(result)) {
			setNewSecret(result.value.secret)
			onRolled?.()
			void reconcileTxid(result.value.txid)
		} else {
			toast.error("Failed to roll API key")
		}
		setIsRolling(false)
	}

	function handleClose(nextOpen: boolean) {
		if (nextOpen) {
			onOpenChange(true)
			return
		}
		onOpenChange(false)
		setNewSecret(null)
	}

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent>
				{newSecret ? (
					<>
						<DialogHeader>
							<DialogTitle>API key rolled</DialogTitle>
							<DialogDescription>
								A new secret has been issued and the previous key was revoked. Copy your new
								key now — you won't be able to see it again.
							</DialogDescription>
						</DialogHeader>
						<DialogPanel>
							<ApiKeySecretReveal secret={newSecret} />
						</DialogPanel>
						<DialogFooter>
							<Button variant="outline" onClick={() => handleClose(false)}>
								Close
							</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>Roll API key?</DialogTitle>
							<DialogDescription>
								A new secret will be issued for{" "}
								<span className="text-foreground font-medium">{apiKey?.name}</span> and the
								current key will be revoked immediately. Any integrations using the old key
								will stop working until you update them with the new one.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="outline" onClick={() => handleClose(false)} disabled={isRolling}>
								Cancel
							</Button>
							<Button variant="destructive" onClick={handleRoll} disabled={isRolling}>
								{isRolling ? "Rolling..." : "Roll key"}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	)
}
