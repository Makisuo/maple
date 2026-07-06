import { Atom } from "@/lib/effect-atom"

export const persistenceErrorAtom = Atom.make<string | null>(null)
