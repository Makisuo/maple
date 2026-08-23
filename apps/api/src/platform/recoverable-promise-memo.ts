/**
 * Share one in-flight/successful asynchronous build and evict a rejected build.
 *
 * The identity guard matters when callers overlap: a late rejection from an
 * older build must never clear the newer promise that a retry already installed.
 */
export const makeRecoverablePromiseMemo = <Args extends ReadonlyArray<unknown>, A>(
	build: (...args: Args) => Promise<A>,
) => {
	let current: Promise<A> | undefined

	const evict = (expected: Promise<A>): boolean => {
		if (current !== expected) return false
		current = undefined
		return true
	}

	const get = (...args: Args): Promise<A> => {
		if (current !== undefined) return current
		const pending = build(...args)
		current = pending
		void pending.catch(() => {
			evict(pending)
		})
		return pending
	}

	return { get, evict }
}
