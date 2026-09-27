/** Build speaker chips from group membership when the API omits speakers[]. */

/**
 * @param {Array<{
 *   isTarget?: boolean,
 *   members?: string[],
 *   coordinator?: string,
 * }>} groups
 * @returns {Array<{
 *   name: string,
 *   inTargetGroup: boolean,
 *   isTargetCoordinator: boolean,
 * }>}
 */
export function speakersFromGroups(groups) {
  const list = Array.isArray(groups) ? groups : [];
  // Do not invent a target when none is marked. A missing room is a failed
  // topology read, not "please pretend the first group is selected".
  const target = list.find((g) => g.isTarget) || null;
  const targetMembers = new Set(
    (target?.members || []).map((n) => String(n).toLowerCase())
  );
  const coord = String(target?.coordinator || "").toLowerCase();
  const names = new Set();
  for (const g of list) {
    for (const n of g.members || []) if (n) names.add(n);
  }
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const key = name.toLowerCase();
      return {
        name,
        inTargetGroup: targetMembers.has(key),
        isTargetCoordinator: key === coord,
      };
    });
}
