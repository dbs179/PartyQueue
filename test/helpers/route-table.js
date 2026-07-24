// Shared route-table extractor for the parity test and its generator script.
// Walks the Express 4 router stack and renders one stable line per route:
// "METHOD /path :: middleware > names > in > order".
//
// Rows are sorted: no two PartyQueue route paths overlap, so registration
// order is not semantically meaningful, and sorting lets route modules
// register in any grouping without breaking parity.

export function routeTable(app) {
  const rows = [];
  for (const layer of app._router.stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods)
      .map((m) => m.toUpperCase())
      .sort()
      .join(",");
    const names = layer.route.stack.map(
      (routeLayer) =>
        routeLayer.handle.displayName || routeLayer.handle.name || "<anonymous>"
    );
    rows.push(`${methods} ${layer.route.path} :: ${names.join(" > ")}`);
  }
  return rows.sort();
}
