import * as React from "react"
import { useAtom, useAtomValue } from "@/lib/effect-atom"
import {
  WidgetBuilderForm,
  WidgetBuilderInitialSnapshot,
  WidgetBuilderPreview,
} from "@/atoms/widget-query-builder-atoms"
import {
  createFormulaDraft,
  createQueryDraft,
  formulaLabel,
  queryLabel,
  type QueryBuilderFormulaDraft,
  type QueryBuilderQueryDraft,
} from "@/lib/query-builder/model"
import {
  toSeriesFieldOptions,
  validateQueries,
} from "@/lib/query-builder/widget-builder-utils"

export function useWidgetBuilder() {
  const formAtom = WidgetBuilderForm.use()
  const [state, setState] = useAtom(formAtom)

  const initialSnapshotAtom = WidgetBuilderInitialSnapshot.use()
  const initialSnapshot = useAtomValue(initialSnapshotAtom)

  const previewAtom = WidgetBuilderPreview.use()
  const [stagedState, setStagedState] = useAtom(previewAtom)

  const validationError = React.useMemo(() => validateQueries(state), [state])
  const seriesFieldOptions = React.useMemo(() => toSeriesFieldOptions(state), [state])

  const updateQuery = (
    id: string,
    updater: (query: QueryBuilderQueryDraft) => QueryBuilderQueryDraft,
  ) => {
    setState((current) => ({
      ...current,
      queries: current.queries.map((query) => (query.id === id ? updater(query) : query)),
    }))
  }

  const addQuery = () => {
    setState((current) => ({
      ...current,
      queries: [...current.queries, createQueryDraft(current.queries.length)],
    }))
  }

  const cloneQuery = (id: string) => {
    setState((current) => {
      const source = current.queries.find((query) => query.id === id)
      if (!source) return current
      const duplicate: QueryBuilderQueryDraft = { ...source, id: crypto.randomUUID() }
      return {
        ...current,
        queries: [...current.queries, duplicate].map((query, index) => ({
          ...query,
          name: queryLabel(index),
        })),
      }
    })
  }

  const removeQuery = (id: string) => {
    setState((current) => {
      if (current.queries.length === 1) return current
      return {
        ...current,
        queries: current.queries
          .filter((query) => query.id !== id)
          .map((query, index) => ({ ...query, name: queryLabel(index) })),
      }
    })
  }

  const addFormula = () => {
    setState((current) => ({
      ...current,
      formulas: [
        ...current.formulas,
        createFormulaDraft(current.formulas.length, current.queries.map((q) => q.name)),
      ],
    }))
  }

  const removeFormula = (id: string) => {
    setState((current) => ({
      ...current,
      formulas: current.formulas
        .filter((formula) => formula.id !== id)
        .map((formula, index) => ({ ...formula, name: formulaLabel(index) })),
    }))
  }

  const updateFormula = (
    id: string,
    updater: (f: QueryBuilderFormulaDraft) => QueryBuilderFormulaDraft,
  ) => {
    setState((current) => ({
      ...current,
      formulas: current.formulas.map((f) => (f.id === id ? updater(f) : f)),
    }))
  }

  const runPreview = () => {
    if (validationError) return
    setStagedState({
      ...state,
      queries: state.queries.map((q) => ({ ...q, addOns: { ...q.addOns } })),
      formulas: state.formulas.map((f) => ({ ...f })),
      listColumns: state.listColumns.map((c) => ({ ...c })),
    })
  }

  return {
    state,
    stagedState,
    initialSnapshot,
    actions: {
      setState,
      updateQuery,
      addQuery,
      cloneQuery,
      removeQuery,
      addFormula,
      removeFormula,
      updateFormula,
      runPreview,
    },
    meta: {
      validationError,
      seriesFieldOptions,
    },
  }
}
