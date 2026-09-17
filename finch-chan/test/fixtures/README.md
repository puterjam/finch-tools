# Petdex 测试 fixture

`sample-config.json` 是标准 8×9 Petdex 图集的状态映射示例。PNG fixture 在
`petdex-to-rgb565.test.mjs` 内按固定像素值生成：它保持仓库无二进制测试资源，且覆盖
8×9 切格、指定有效帧、RGB565 little-endian、offset 与 CRC32。

真实 Petdex PNG 可直接执行：

```sh
node tools/petdex-to-rgb565.mjs ./petdex.png ./data ./test/fixtures/sample-config.json
```
