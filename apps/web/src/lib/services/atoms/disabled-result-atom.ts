import { Atom, Result } from "@/lib/effect-atom"

const disabledResultQueryAtom = Atom.make(Result.initial<never, Error>()).pipe(Atom.keepAlive)

export const disabledResultAtom = <A, E = Error>() =>
	disabledResultQueryAtom as unknown as Atom.Atom<Result.Result<A, E>>
