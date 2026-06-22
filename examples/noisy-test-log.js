for (let index = 1; index <= 40; index += 1) {
  const status = index % 11 === 0 ? "warning" : "ok";
  console.log(`file${index}.ts:${index}:TODO item ${index} status=${status}`);
}
