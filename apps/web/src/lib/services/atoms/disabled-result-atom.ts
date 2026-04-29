import { Atom, Result } from "@/lib/effect-atom"

const disabledResultQueryAtom = Atom.make(Result.initial<never, unknown>()).pipe(Atom.keepAlive)

export const disabledResultAtom = <A, E = unknown>() =>
	disabledResultQueryAtom as unknown as Atom.Atom<Result.Result<A, E>>
