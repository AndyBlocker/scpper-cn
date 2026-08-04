/** 临时排查工具：打印单页提取结果。用法 node --import tsx/esm experiments/_dump-extract.ts <file.html> [len] */
import fs from 'node:fs';
import { extractTextContent } from '../src/content/extractText.js';
const h = fs.readFileSync(process.argv[2]!, 'utf-8');
const r = extractTextContent(h);
console.log('container=%s dropped=%d warnings=%o len=%d', r.container, r.droppedSubtrees, r.warnings, r.text.length);
console.log(r.text.slice(0, Number(process.argv[3] ?? 600)));
