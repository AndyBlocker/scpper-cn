import { promises as fs } from 'node:fs';
import path from 'node:path';

async function getAllFiles(dir: string, extensions: string[] = []): Promise<string[]> {
  const files: string[] = [];
  
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        // Skip node_modules and .git directories
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
          continue;
        }
        files.push(...(await getAllFiles(fullPath, extensions)));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.length === 0 || extensions.includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  } catch (error) {
    console.warn(`Cannot read directory ${dir}:`, error.message);
  }
  
  return files;
}

async function exportCode() {
  try {
    const directories = ['prisma', 'scripts', 'src'];
    const codeExtensions = ['.ts', '.js', '.json', '.prisma', '.sql', '.md'];
    
    let output = '# SCPPER-CN Backend Code Export\n\n';
    output += `Generated on: ${new Date().toISOString()}\n\n`;
    output += '## Table of Contents\n\n';
    
    const allFiles: string[] = [];
    
    // Collect all files from specified directories
    for (const dir of directories) {
      const dirPath = path.resolve(dir);
      try {
        await fs.access(dirPath);
        const files = await getAllFiles(dirPath, codeExtensions);
        allFiles.push(...files);
      } catch (error) {
        console.warn(`Directory ${dir} not found, skipping...`);
      }
    }
    
    // Add package.json and other root config files
    const rootFiles = ['package.json', 'tsconfig.json', '.env.example', 'MIGRATION.md'];
    for (const file of rootFiles) {
      try {
        await fs.access(file);
        allFiles.push(path.resolve(file));
      } catch (error) {
        // File doesn't exist, skip
      }
    }
    
    // Sort files alphabetically
    allFiles.sort();
    
    // Generate table of contents
    for (const filePath of allFiles) {
      const relativePath = path.relative(process.cwd(), filePath);
      output += `- [${relativePath}](#${relativePath.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()})\n`;
    }
    
    output += '\n---\n\n';
    
    // Export each file
    for (const filePath of allFiles) {
      const relativePath = path.relative(process.cwd(), filePath);
      const fileName = path.basename(filePath);
      
      output += `## ${relativePath}\n\n`;
      
      try {
        const content = await fs.readFile(filePath, 'utf8');
        
        // Determine file type for syntax highlighting
        const ext = path.extname(fileName);
        let language = '';
        switch (ext) {
          case '.ts':
            language = 'typescript';
            break;
          case '.js':
            language = 'javascript';
            break;
          case '.json':
            language = 'json';
            break;
          case '.sql':
            language = 'sql';
            break;
          case '.prisma':
            language = 'prisma';
            break;
          case '.md':
            language = 'markdown';
            break;
          default:
            language = 'text';
        }
        
        output += `\`\`\`${language}\n${content}\n\`\`\`\n\n`;
        
      } catch (error) {
        output += `*Error reading file: ${error.message}*\n\n`;
      }
      
      output += '---\n\n';
      
      console.log(`Exported: ${relativePath}`);
    }
    
    // Write output file
    const outputFile = `scpper-cn-backend-export-${new Date().toISOString().slice(0, 10)}.txt`;
    await fs.writeFile(outputFile, output, 'utf8');
    
    console.log(`\n✅ Code export completed!`);
    console.log(`📁 Output file: ${outputFile}`);
    console.log(`📊 Total files exported: ${allFiles.length}`);
    console.log(`📝 Total characters: ${output.length.toLocaleString()}`);
    
  } catch (error) {
    console.error('Export failed:', error);
    process.exit(1);
  }
}

exportCode();