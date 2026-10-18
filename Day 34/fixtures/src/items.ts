export interface Item {
  id: string;
  name: string;
  unitPrice: number;
}

const catalog: Item[] = [
  { id: "widget-a", name: "Widget A", unitPrice: 12.5 },
  { id: "widget-b", name: "Widget B", unitPrice: 8.0 },
];

export function listItems(): Item[] {
  return [...catalog];
}

export function getItem(id: string): Item | undefined {
  return catalog.find((item) => item.id === id);
}
