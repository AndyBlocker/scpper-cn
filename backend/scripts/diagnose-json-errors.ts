#!/usr/bin/env npx tsx

import { promises as fs } from 'node:fs';
import { robustJsonParse } from './fix-json-parser.js';

async function extractProblematicLines(inputPath: string, outputPath: string) {
  try {
    console.log(`Diagnosing ${inputPath}...`);
    
    const content = await fs.readFile(inputPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    
    const problematicLines: Array<{
      lineNumber: number;
      content: string;
      error: string;
      context: string[];
    }> = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Try normal JSON parsing first
      try {
        JSON.parse(line);
        continue; // This line is fine
      } catch (normalError) {
        // Try robust parsing
        const parsed = robustJsonParse(line);
        if (parsed !== null) {
          continue; // Robust parsing succeeded
        }
        
        // Both failed, this is a problematic line
        const context = [];
        const contextStart = Math.max(0, i - 2);
        const contextEnd = Math.min(lines.length, i + 3);
        
        for (let j = contextStart; j < contextEnd; j++) {
          const marker = j === i ? '>>> PROBLEM: ' : '    ';
          context.push(`${marker}Line ${j + 1}: ${lines[j].substring(0, 200)}${lines[j].length > 200 ? '...' : ''}`);
        }
        
        problematicLines.push({
          lineNumber: i + 1,
          content: line,
          error: normalError.message,
          context,
        });
      }
    }
    
    // Generate detailed report
    let report = `# JSON Parsing Error Diagnosis Report\n\n`;
    report += `File: ${inputPath}\n`;
    report += `Total lines: ${lines.length}\n`;
    report += `Problematic lines: ${problematicLines.length}\n`;
    report += `Success rate: ${((lines.length - problematicLines.length) / lines.length * 100).toFixed(2)}%\n\n`;
    
    report += `## Error Summary\n\n`;
    const errorTypes = new Map<string, number>();
    problematicLines.forEach(item => {
      const errorType = item.error.split(':')[0];
      errorTypes.set(errorType, (errorTypes.get(errorType) || 0) + 1);
    });
    
    for (const [errorType, count] of errorTypes.entries()) {
      report += `- ${errorType}: ${count} occurrences\n`;
    }
    
    report += `\n## Detailed Analysis\n\n`;
    
    for (let i = 0; i < problematicLines.length; i++) {
      const item = problematicLines[i];
      report += `### Problem ${i + 1}: Line ${item.lineNumber}\n\n`;
      report += `**Error**: ${item.error}\n\n`;
      
      // Analyze the content
      const content = item.content;
      const analysis = analyzeJsonProblem(content);
      report += `**Analysis**:\n`;
      for (const issue of analysis) {
        report += `- ${issue}\n`;
      }
      report += `\n**Context**:\n`;
      report += '```\n';
      for (const contextLine of item.context) {
        report += contextLine + '\n';
      }
      report += '```\n\n';
      
      // Show problematic characters
      report += `**Problematic Characters Found**:\n`;
      const problemChars = findProblematicCharacters(content);
      if (problemChars.length > 0) {
        for (const char of problemChars) {
          report += `- Position ${char.position}: "${char.char}" (Unicode: U+${char.code.toString(16).toUpperCase().padStart(4, '0')})\n`;
        }
      } else {
        report += '- No obvious problematic characters detected\n';
      }
      report += '\n';
      
      // Show first 500 characters of the line
      report += `**Content Preview** (first 500 chars):\n`;
      report += '```json\n';
      report += content.substring(0, 500);
      if (content.length > 500) {
        report += '\n... (truncated)';
      }
      report += '\n```\n\n';
      
      report += '---\n\n';
    }
    
    // Write the report
    await fs.writeFile(outputPath, report);
    
    console.log(`Diagnosis completed:`);
    console.log(`  Total lines analyzed: ${lines.length}`);
    console.log(`  Problematic lines found: ${problematicLines.length}`);
    console.log(`  Report saved to: ${outputPath}`);
    
    return problematicLines;
    
  } catch (error) {
    console.error(`Failed to diagnose ${inputPath}:`, error.message);
    throw error;
  }
}

function analyzeJsonProblem(content: string): string[] {
  const issues: string[] = [];
  
  // Check for common JSON problems
  if (content.includes('�')) {
    issues.push('Contains malformed Unicode replacement characters (�)');
  }
  
  if (/[^\x20-\x7E\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(content)) {
    issues.push('Contains unusual Unicode characters outside normal ranges');
  }
  
  if (content.includes('\n') && !content.includes('\\n')) {
    issues.push('Contains unescaped newlines');
  }
  
  if (content.includes('\r') && !content.includes('\\r')) {
    issues.push('Contains unescaped carriage returns');
  }
  
  // Check for unbalanced braces
  const openBraces = (content.match(/\{/g) || []).length;
  const closeBraces = (content.match(/\}/g) || []).length;
  if (openBraces !== closeBraces) {
    issues.push(`Unbalanced braces: ${openBraces} open, ${closeBraces} close`);
  }
  
  // Check for unbalanced brackets
  const openBrackets = (content.match(/\[/g) || []).length;
  const closeBrackets = (content.match(/\]/g) || []).length;
  if (openBrackets !== closeBrackets) {
    issues.push(`Unbalanced brackets: ${openBrackets} open, ${closeBrackets} close`);
  }
  
  // Check for quote issues
  const quotes = (content.match(/"/g) || []).length;
  if (quotes % 2 !== 0) {
    issues.push(`Odd number of quotes (${quotes}) - likely unescaped quotes`);
  }
  
  // Check if line is truncated
  if (!content.trim().endsWith('}') && !content.trim().endsWith(']')) {
    issues.push('Line appears to be truncated (doesn\'t end with } or ])');
  }
  
  // Check for control characters
  if (/[\x00-\x1F\x7F-\x9F]/.test(content)) {
    issues.push('Contains control characters');
  }
  
  if (issues.length === 0) {
    issues.push('No obvious structural issues detected - may be complex parsing problem');
  }
  
  return issues;
}

function findProblematicCharacters(content: string): Array<{position: number, char: string, code: number}> {
  const problematic: Array<{position: number, char: string, code: number}> = [];
  
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const code = char.charCodeAt(0);
    
    // Check for various problematic character ranges
    if (
      code === 0xFFFD || // Replacement character
      (code >= 0x00 && code <= 0x1F && code !== 0x09 && code !== 0x0A && code !== 0x0D) || // Control chars except tab, LF, CR
      (code >= 0x7F && code <= 0x9F) // Additional control chars
    ) {
      problematic.push({ position: i, char, code });
    }
  }
  
  return problematic;
}

async function main() {
  const inputFile = process.argv[2];
  const outputFile = process.argv[3] || inputFile.replace('.jsonl', '-diagnosis.md');
  
  if (!inputFile) {
    console.log('Usage: diagnose-json-errors <input.jsonl> [output-report.md]');
    console.log('');
    console.log('Examples:');
    console.log('  diagnose-json-errors .cache/phase2.jsonl');
    console.log('  diagnose-json-errors .cache/phase2.jsonl phase2-errors.md');
    process.exit(1);
  }
  
  try {
    const problematicLines = await extractProblematicLines(inputFile, outputFile);
    
    console.log('\n🔍 Quick Summary:');
    if (problematicLines.length > 0) {
      console.log(`Found ${problematicLines.length} problematic lines:`);
      problematicLines.slice(0, 5).forEach(item => {
        console.log(`  Line ${item.lineNumber}: ${item.error}`);
      });
      if (problematicLines.length > 5) {
        console.log(`  ... and ${problematicLines.length - 5} more`);
      }
    } else {
      console.log('No problematic lines found!');
    }
    
    console.log(`\n📄 Detailed report saved to: ${outputFile}`);
    console.log('✅ Diagnosis completed successfully!');
    
  } catch (error) {
    console.error('❌ Diagnosis failed:', error.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}