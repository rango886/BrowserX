#!/usr/bin/env node
// 入口：Node 22.18+/24 可以直接运行 .ts（类型擦除），不需要编译
process.removeAllListeners('warning')
await import('../src/cli/main.ts')
