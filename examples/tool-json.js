const rows = Array.from({ length: 30 }, (_, index) => ({
  id: index,
  status: index % 6 === 0 ? "warning" : "ok",
  path: `src/file${index}.js`,
}));

console.log(JSON.stringify({ items: rows }, null, 2));
