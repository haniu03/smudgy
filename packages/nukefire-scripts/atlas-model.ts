export interface SearchableGpsDestination {
  name: string;
  category: string;
  aliases: string;
  tags: string;
  difficulty: string;
  zone: number;
}

function matches(destination: SearchableGpsDestination, needle: string): boolean {
  return destination.name.toLowerCase().includes(needle) ||
    destination.category.toLowerCase().includes(needle) ||
    destination.aliases.toLowerCase().includes(needle) ||
    destination.tags.toLowerCase().includes(needle) ||
    destination.difficulty.toLowerCase().includes(needle) ||
    String(destination.zone) === needle;
}

/**
 * Filter the GPS catalog without disturbing server order, except that an
 * exact zone-number match outranks incidental name/alias/tag matches.
 */
export function filteredGpsDestinations<T extends SearchableGpsDestination>(
  catalog: readonly T[],
  filter: string,
): T[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return [...catalog];

  return catalog
    .map((destination, index) => ({
      destination,
      index,
      exactZone: String(destination.zone) === needle,
    }))
    .filter(({ destination }) => matches(destination, needle))
    .sort((a, b) => Number(b.exactZone) - Number(a.exactZone) || a.index - b.index)
    .map(({ destination }) => destination);
}
