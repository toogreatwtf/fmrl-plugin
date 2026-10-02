import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
const source = new URL('../src/vendor/', import.meta.url);
const target = new URL('../dist/vendor/', import.meta.url);
mkdirSync(target, { recursive: true });
for (const name of readdirSync(source)) copyFileSync(new URL(name, source), new URL(name, target));
