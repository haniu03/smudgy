interface ContextAction {
  id?: string;
}

interface ContextEntry<A extends ContextAction> {
  id?: string;
  actions: readonly A[];
}

/** BIGMAP is represented by Radar, so omit its Zone Intelligence action. */
export function visibleContexts<A extends ContextAction, T extends ContextEntry<A>>(
  contexts: readonly T[],
): T[] {
  return contexts.map((entry) => {
    if (entry.id?.toLowerCase() !== "zone-intelligence") return entry;
    return {
      ...entry,
      actions: entry.actions.filter((action) => action.id?.toLowerCase() !== "bigmap"),
    };
  });
}
