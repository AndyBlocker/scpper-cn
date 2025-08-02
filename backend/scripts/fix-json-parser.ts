import { promises as fs } from 'node:fs';

// New function to repair split JSON lines caused by U+FFFD and malformed line breaks
export function repairSplitJsonLines(lines: string[]): string[] {
  const repairedLines: string[] = [];
  let pendingLine = '';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if this line starts with U+FFFD (replacement character) or looks like broken text
    const startsWithReplacement = line.length > 0 && line.charCodeAt(0) === 0xFFFD;
    const looksLikeBrokenContent = !line.trim().startsWith('{') && 
                                   !line.trim().startsWith('[') && 
                                   line.trim().length > 0 &&
                                   repairedLines.length > 0;
    
    if (startsWithReplacement || looksLikeBrokenContent) {
      // Clean the line by removing leading U+FFFD if present
      const cleanLine = startsWithReplacement ? line.substring(1) : line;
      
      if (repairedLines.length > 0) {
        // Try merging with the last added line
        const lastLine = repairedLines.pop()!;
        
        // Special case: if last line ends with }}, it might be a complete JSON that was split
        // We need to insert the broken content into the appropriate field
        let merged = '';
        if (lastLine.endsWith('}}')) {
          // Try to find where to insert the broken content
          // Look for the last occurrence of a text field like "source" or "textContent"
          const sourceMatch = lastLine.match(/"source":"([^"]*)"(?=[^"]*$)/);
          const textContentMatch = lastLine.match(/"textContent":"([^"]*)"(?=[^"]*$)/);
          
          if (sourceMatch || textContentMatch) {
            // Found a text field, insert the broken content there
            const fieldName = sourceMatch ? 'source' : 'textContent';
            const fieldValue = sourceMatch ? sourceMatch[1] : textContentMatch![1];
            
            // Replace the field value with the combined content
            const combinedContent = fieldValue + '\\n' + cleanLine.replace(/"/g, '\\"').replace(/\n/g, '\\n');
            merged = lastLine.replace(
              new RegExp(`"${fieldName}":"[^"]*"`),
              `"${fieldName}":"${combinedContent}"`
            );
          } else {
            // No text field found, try simple concatenation
            merged = lastLine.slice(0, -2) + '\\n' + cleanLine.replace(/"/g, '\\"').replace(/\n/g, '\\n') + '}}';
          }
        } else {
          // Simple concatenation
          merged = lastLine + cleanLine;
        }
        
        // Test if the merged line forms valid JSON
        try {
          JSON.parse(merged);
          // Success! Replace the last line with merged version
          repairedLines.push(merged);
          continue;
        } catch (error) {
          // Merging failed, try a different approach
          // Maybe the broken line should be part of the previous line's text content
          try {
            const escapedContent = cleanLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
            const altMerged = lastLine.slice(0, -2) + escapedContent + '}}';
            JSON.parse(altMerged);
            repairedLines.push(altMerged);
            continue;
          } catch (altError) {
            // Both approaches failed, restore the last line and skip the broken line
            repairedLines.push(lastLine);
            console.warn(`Could not repair broken line ${i + 1}: ${line.substring(0, 100)}...`);
            continue;
          }
        }
      } else {
        // No previous line to merge with, skip this broken line
        console.warn(`Skipping orphaned broken line ${i + 1}: ${line.substring(0, 100)}...`);
        continue;
      }
    }
    
    // Check if we have a pending line to resolve
    if (pendingLine) {
      // Try to merge pending with current line
      const merged = pendingLine + line;
      
      try {
        JSON.parse(merged);
        // Success! Add the merged line
        repairedLines.push(merged);
        pendingLine = '';
        continue;
      } catch (error) {
        // Merging didn't work, add pending as-is and process current line normally
        repairedLines.push(pendingLine);
        pendingLine = '';
        // Fall through to process current line normally
      }
    }
    
    // Process line normally - check if it's a complete JSON object
    if (line.trim()) {
      try {
        JSON.parse(line);
        // Valid JSON, add it
        repairedLines.push(line);
      } catch (error) {
        // Not valid JSON, might be start of split line
        if (line.trim().startsWith('{') && !line.trim().endsWith('}')) {
          // Looks like start of JSON object, make it pending
          pendingLine = line;
        } else {
          // Line doesn't look like valid JSON start, skip it
          console.warn(`Skipping malformed line ${i + 1}: ${line.substring(0, 100)}...`);
        }
      }
    }
  }
  
  // Handle any remaining pending line
  if (pendingLine) {
    repairedLines.push(pendingLine);
  }
  
  return repairedLines;
}

export function safeJsonParse(jsonString: string, lineNumber?: number): any | null {
  // Try normal parsing first
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    // If normal parsing fails, try to fix common issues
    try {
      return fixAndParseJson(jsonString);
    } catch (fixError) {
      if (lineNumber) {
        console.warn(`Failed to parse line ${lineNumber}: ${error.message.substring(0, 100)}`);
      }
      return null;
    }
  }
}

function fixAndParseJson(jsonString: string): any {
  let fixed = jsonString;
  
  // Fix 1: Handle unescaped quotes in string values
  // This is tricky because we need to distinguish between structural quotes and content quotes
  fixed = fixUnescapedQuotes(fixed);
  
  // Fix 2: Handle malformed Unicode characters
  fixed = fixMalformedUnicode(fixed);
  
  // Fix 3: Handle unescaped newlines in strings
  fixed = fixUnescapedNewlines(fixed);
  
  // Fix 4: Handle trailing commas
  fixed = fixed.replace(/,(\s*[}\]])/g, '$1');
  
  // Try parsing the fixed string
  return JSON.parse(fixed);
}

function fixUnescapedQuotes(str: string): string {
  let result = '';
  let inString = false;
  let inEscape = false;
  let stringStart = -1;
  
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const nextChar = str[i + 1];
    
    if (inEscape) {
      result += char;
      inEscape = false;
      continue;
    }
    
    if (char === '\\') {
      inEscape = true;
      result += char;
      continue;
    }
    
    if (char === '"') {
      if (!inString) {
        // Starting a string
        if (i > 0 && /[\w}]/.test(str[i - 1])) {
          // This might be a quote inside content, not a string delimiter
          result += '\\"';
          continue;
        }
        inString = true;
        stringStart = i;
        result += char;
      } else {
        // Potentially ending a string
        // Check if this is a structural quote (followed by : or , or } or ])
        if (/\s*[:\,}\]]/.test(str.substring(i + 1, i + 5))) {
          // This is likely a structural quote
          inString = false;
          result += char;
        } else {
          // This might be an unescaped quote in content
          result += '\\"';
        }
      }
    } else {
      result += char;
    }
  }
  
  return result;
}

function fixMalformedUnicode(str: string): string {
  // Replace malformed Unicode sequences with placeholder
  return str.replace(/[\uFFFD\u0000-\u001F\u007F-\u009F]/g, (match) => {
    // Replace control characters and replacement characters
    if (match === '\n') return '\\n';
    if (match === '\r') return '\\r';
    if (match === '\t') return '\\t';
    return ''; // Remove other problematic characters
  });
}

function fixUnescapedNewlines(str: string): string {
  let result = '';
  let inString = false;
  let inEscape = false;
  
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    
    if (inEscape) {
      result += char;
      inEscape = false;
      continue;
    }
    
    if (char === '\\') {
      inEscape = true;
      result += char;
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }
    
    if (inString && (char === '\n' || char === '\r')) {
      // Replace unescaped newlines in strings
      result += char === '\n' ? '\\n' : '\\r';
    } else {
      result += char;
    }
  }
  
  return result;
}

// Alternative approach: Try multiple repair strategies
export function robustJsonParse(jsonString: string, lineNumber?: number): any | null {
  const strategies = [
    // Strategy 1: Normal parsing
    (str: string) => JSON.parse(str),
    
    // Strategy 2: Fix escaped quotes
    (str: string) => JSON.parse(fixAndParseJson(str)),
    
    // Strategy 3: Replace problematic characters
    (str: string) => {
      const cleaned = str
        .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove control characters
        .replace(/\uFFFD/g, '') // Remove replacement characters
        .replace(/([^\\])"/g, '$1\\"') // Escape unescaped quotes (simple heuristic)
        .replace(/\\"/g, '\\"'); // Ensure quotes are properly escaped
      return JSON.parse(cleaned);
    },
    
    // Strategy 4: Truncate at first major parsing error
    (str: string) => {
      // Find the last complete JSON object
      let braceCount = 0;
      let lastValidPos = -1;
      
      for (let i = 0; i < str.length; i++) {
        if (str[i] === '{') braceCount++;
        else if (str[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            lastValidPos = i;
          }
        }
      }
      
      if (lastValidPos > 0) {
        return JSON.parse(str.substring(0, lastValidPos + 1));
      }
      throw new Error('No valid JSON structure found');
    }
  ];
  
  for (let i = 0; i < strategies.length; i++) {
    try {
      return strategies[i](jsonString);
    } catch (error) {
      if (i === strategies.length - 1) {
        // Last strategy failed
        if (lineNumber) {
          console.warn(`All parsing strategies failed for line ${lineNumber}: ${error.message.substring(0, 100)}`);
        }
        return null;
      }
    }
  }
  
  return null;
}