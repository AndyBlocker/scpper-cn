import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

import { SQL_TUNING_CONSTANTS, type SqlTuningConstantName } from './sqlTuning.js';

export interface TypeScriptSource {
  path: string;
  source: string;
}

function isNamedCall(node: ts.CallExpression, name: string): boolean {
  return ts.isIdentifier(node.expression) && node.expression.text === name;
}

/** 只认 query(db,label,sql,[...]) 的参数数组；注释、普通函数调用和 JS 计算都不能充数。 */
export function findMissingSqlTuningBindings(
  sources: readonly TypeScriptSource[],
): SqlTuningConstantName[] {
  const found = new Set<SqlTuningConstantName>();
  for (const input of sources) {
    const sourceFile = ts.createSourceFile(
      input.path,
      input.source,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && isNamedCall(node, 'query')) {
        const params = node.arguments[3];
        if (params && ts.isArrayLiteralExpression(params)) {
          function inspectParam(value: ts.Node): void {
            if (ts.isCallExpression(value) && isNamedCall(value, 'bindSqlTuning')) {
              const name = value.arguments[0];
              if (name && ts.isStringLiteral(name)
                  && name.text in SQL_TUNING_CONSTANTS) {
                found.add(name.text as SqlTuningConstantName);
              }
            }
            ts.forEachChild(value, inspectParam);
          }
          inspectParam(params);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return (Object.keys(SQL_TUNING_CONSTANTS) as SqlTuningConstantName[])
    .filter((name) => !found.has(name));
}

export async function loadTypeScriptSources(root: string): Promise<TypeScriptSource[]> {
  const sources: TypeScriptSource[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        sources.push({ path: file, source: await readFile(file, 'utf8') });
      }
    }
  }
  await walk(root);
  return sources;
}

export async function assertSqlTuningBindings(root: string): Promise<void> {
  const missing = findMissingSqlTuningBindings(await loadTypeScriptSources(root));
  if (missing.length > 0) {
    throw new Error(`导出的 SQL 调参常量未出现在 query() 参数位：${missing.join(', ')}`);
  }
}
