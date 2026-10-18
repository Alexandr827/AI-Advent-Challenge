# Public API

## Items

- `listItems()` — returns all catalog items.
- `getItem(id: string)` — returns one item or `undefined`.

## Quote

`quote(item, qty)` returns a **number**: the line total (`unitPrice * qty`).

There are no optional parameters.
