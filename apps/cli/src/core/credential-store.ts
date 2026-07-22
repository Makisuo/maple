const SERVICE = "maple-cli"

const run = async (cmd: string[], stdin?: string): Promise<{ ok: boolean; stdout: string }> => {
	try {
		const process = Bun.spawn({
			cmd,
			stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
			stdout: "pipe",
			stderr: "ignore",
		})
		const [exitCode, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()])
		return { ok: exitCode === 0, stdout: stdout.trim() }
	} catch {
		return { ok: false, stdout: "" }
	}
}

export const credentialAccount = (apiUrl: string): string => new URL(apiUrl).origin

export const readNativeCredential = async (apiUrl: string): Promise<string | undefined> => {
	const account = credentialAccount(apiUrl)
	if (process.platform === "darwin") {
		const result = await run([
			"/usr/bin/security",
			"find-generic-password",
			"-s",
			SERVICE,
			"-a",
			account,
			"-w",
		])
		return result.ok && result.stdout ? result.stdout : undefined
	}
	if (process.platform === "linux") {
		const result = await run(["secret-tool", "lookup", "service", SERVICE, "origin", account])
		return result.ok && result.stdout ? result.stdout : undefined
	}
	return undefined
}

export const writeNativeCredential = async (apiUrl: string, token: string): Promise<boolean> => {
	const account = credentialAccount(apiUrl)
	if (process.platform === "darwin") {
		// With -w as the final option and no argument, `security` reads the secret
		// from stdin instead of exposing it in the process list.
		const result = await run(
			["/usr/bin/security", "add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w"],
			`${token}\n`,
		)
		return result.ok
	}
	if (process.platform === "linux") {
		const result = await run(
			["secret-tool", "store", "--label=Maple CLI", "service", SERVICE, "origin", account],
			`${token}\n`,
		)
		return result.ok
	}
	return false
}

export const deleteNativeCredential = async (apiUrl: string): Promise<void> => {
	const account = credentialAccount(apiUrl)
	if (process.platform === "darwin") {
		await run(["/usr/bin/security", "delete-generic-password", "-s", SERVICE, "-a", account])
		return
	}
	if (process.platform === "linux") {
		await run(["secret-tool", "clear", "service", SERVICE, "origin", account])
	}
}
