#!/usr/bin/env npx tsx

import { promises as fs } from 'node:fs';
import { robustJsonParse, repairSplitJsonLines } from './fix-json-parser.js';

async function repairJsonlFile(inputPath: string, outputPath: string) {
  try {
    console.log(`Repairing ${inputPath}...`);
    
    const content = await fs.readFile(inputPath, 'utf8');
    const originalLines = content.split('\n').filter(Boolean);
    
    console.log(`  Original lines: ${originalLines.length}`);
    console.log(`  Pre-processing split lines caused by U+FFFD...`);
    
    // First, repair lines that were split by U+FFFD and malformed line breaks
    const lines = repairSplitJsonLines(originalLines);
    
    console.log(`  After line repair: ${lines.length} lines (${originalLines.length - lines.length} lines merged)`);
    
    let repaired = 0;
    let failed = 0;
    const repairedLines: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // First try normal parsing
      try {
        JSON.parse(line);
        repairedLines.push(line);
        continue;
      } catch (error) {
        // Normal parsing failed, try robust parsing
        const parsed = robustJsonParse(line, i + 1);
        if (parsed !== null) {
          // Successfully parsed, re-stringify to ensure valid JSON
          repairedLines.push(JSON.stringify(parsed));
          repaired++;
        } else {
          // Even robust parsing failed, skip this line
          console.warn(`Skipping unparseable line ${i + 1}`);
          failed++;
        }
      }
    }
    
    // Write repaired file
    await fs.writeFile(outputPath, repairedLines.join('\n') + '\n');
    
    console.log(`Repair completed for ${inputPath}:`);
    console.log(`  Original lines: ${lines.length}`);
    console.log(`  Repaired lines: ${repaired}`);
    console.log(`  Failed lines: ${failed}`);
    console.log(`  Output lines: ${repairedLines.length}`);
    console.log(`  Output file: ${outputPath}`);
    
    return {
      original: lines.length,
      repaired,
      failed,
      output: repairedLines.length
    };
    
  } catch (error) {
    console.error(`Failed to repair ${inputPath}:`, error.message);
    throw error;
  }
}

async function main() {
  const inputFile = process.argv[2];
  const outputFile = process.argv[3];
  
  if (!inputFile || !outputFile) {
    console.log('Usage: repair-jsonl <input.jsonl> <output.jsonl>');
    console.log('');
    console.log('Examples:');
    console.log('  repair-jsonl .cache/phase2.jsonl .cache/phase2-fixed.jsonl');
    console.log('  repair-jsonl .cache/phase3.jsonl .cache/phase3-fixed.jsonl');
    process.exit(1);
  }
  
  try {
    await repairJsonlFile(inputFile, outputFile);
    console.log('✅ Repair completed successfully!');
  } catch (error) {
    console.error('❌ Repair failed:', error.message);
    process.exit(1);
  }
}

// Also export function for batch repair
export async function repairAllCacheFiles(cacheDir: string = '.cache') {
  const results = {
    phase1: null as any,
    phase2: null as any,
    phase3: null as any,
  };
  
  const files = [
    { input: `${cacheDir}/phase1.jsonl`, output: `${cacheDir}/phase1-fixed.jsonl`, key: 'phase1' },
    { input: `${cacheDir}/phase2.jsonl`, output: `${cacheDir}/phase2-fixed.jsonl`, key: 'phase2' },
    { input: `${cacheDir}/phase3.jsonl`, output: `${cacheDir}/phase3-fixed.jsonl`, key: 'phase3' },
  ];
  
  for (const file of files) {
    try {
      await fs.access(file.input);
      results[file.key] = await repairJsonlFile(file.input, file.output);
    } catch (error) {
      console.log(`File ${file.input} not found, skipping...`);
    }
  }
  
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}