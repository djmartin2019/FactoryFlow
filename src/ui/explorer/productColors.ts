/** One stable colour per product, by position in the master product list, shared by the chart, legend and table. */
const PALETTE = ["#4da3ff", "#ffb454", "#5be3a0", "#c58bff", "#ff7d9c", "#e8de5a", "#2ee6ff", "#ff9a5c"];

export const productColor = (index: number): string => PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length]!;
