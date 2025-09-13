import { PrismaClient } from '@prisma/client';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import pLimit from 'p-limit';
import { Logger } from '../utils/Logger.js';

interface EmbeddingConfig {
  modelName: string;
  dimension: number;
  batchSize: number;
  maxConcurrency: number;
  pythonPath?: string;
}

interface ChunkData {
  pageId: number;
  chunkIndex: number;
  content: string;
  lang?: string;
}

interface EmbeddingResult {
  pageId: number;
  chunkIndex: number;
  embedding: number[];
  tokens: number;
}

export class EmbeddingService extends EventEmitter {
  private prisma: PrismaClient;
  private config: EmbeddingConfig;
  private pythonProcess: any;
  private isInitialized: boolean = false;
  private limit: any;
  private stdoutBuffer: string = '';
  private pendingResolvers: Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timeout: NodeJS.Timeout } > = new Map();

  constructor(prisma: PrismaClient, config: Partial<EmbeddingConfig> = {}) {
    super();
    this.prisma = prisma;
    this.config = {
      modelName: 'sentence-transformers/gte-multilingual-base',
      dimension: 768,
      batchSize: 32,
      maxConcurrency: 4,
      pythonPath: 'python3',
      ...config
    };
    this.limit = pLimit(this.config.maxConcurrency);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Check if the embedding model is active
      const activeModel = await this.prisma.$queryRaw<any[]>`
        SELECT * FROM "EmbeddingModel" 
        WHERE "isActive" = true 
        LIMIT 1
      `;

      if (activeModel.length === 0) {
        // Insert default model if none exists
        await this.prisma.$executeRaw`
          INSERT INTO "EmbeddingModel" (name, dimension, metric, description, "isActive")
          VALUES (${this.config.modelName}, ${this.config.dimension}, 'cosine', 
                  'Default multilingual embedding model', true)
          ON CONFLICT (name) DO UPDATE SET "isActive" = true
        `;
      }

      // Initialize Python embedding service
      await this.initializePythonService();
      
      this.isInitialized = true;
      Logger.info('EmbeddingService initialized successfully');
    } catch (error) {
      Logger.error('Failed to initialize EmbeddingService:', error);
      throw error;
    }
  }

  private async initializePythonService(): Promise<void> {
    // Create Python script for embedding generation
    const pythonScript = `
import sys
import json
import numpy as np
from fastembed import TextEmbedding
import logging

logging.basicConfig(level=logging.INFO)

# Initialize model
model = TextEmbedding(
    model_name="${this.config.modelName}",
    max_length=512,
    cache_dir="./models",
    threads=16
)

# Process requests
while True:
    try:
        line = sys.stdin.readline()
        if not line:
            break
            
        request = json.loads(line)
        texts = request['texts']
        
        # Generate embeddings
        embeddings = list(model.embed(texts))
        
        # Convert to list and send response
        response = {
            'embeddings': [emb.tolist() for emb in embeddings],
            'request_id': request.get('request_id')
        }
        
        print(json.dumps(response))
        sys.stdout.flush()
        
    except Exception as e:
        error_response = {
            'error': str(e),
            'request_id': request.get('request_id') if 'request' in locals() else None
        }
        print(json.dumps(error_response))
        sys.stdout.flush()
`;

    // Write Python script to temp file
    const fs = require('fs').promises;
    const path = require('path');
    const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'embedding_service.py');
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(scriptPath, pythonScript);

    // Start Python process
    this.pythonProcess = spawn(this.config.pythonPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.pythonProcess.stderr.on('data', (data: Buffer) => {
      Logger.error(`Python embedding service error: ${data.toString()}`);
    });

    this.pythonProcess.on('error', (err: Error) => {
      Logger.error('Python embedding service process error:', err);
    });

    this.pythonProcess.on('exit', (code: number, signal: string) => {
      Logger.warn(`Python embedding service exited (code=${code}, signal=${signal})`);
      // Reject all pending requests
      for (const [, h] of this.pendingResolvers) {
        clearTimeout(h.timeout);
        h.reject(new Error('Embedding service exited'));
      }
      this.pendingResolvers.clear();
      this.isInitialized = false;
    });

    // Line-buffered stdout JSON protocol
    this.pythonProcess.stdout.on('data', (data: Buffer) => {
      this.stdoutBuffer += data.toString();
      let idx;
      while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
        const line = this.stdoutBuffer.slice(0, idx);
        this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const requestId = msg.request_id ?? msg.requestId;
          if (requestId && this.pendingResolvers.has(requestId)) {
            const handler = this.pendingResolvers.get(requestId)!;
            clearTimeout(handler.timeout);
            this.pendingResolvers.delete(requestId);
            if (msg.error) {
              handler.reject(new Error(msg.error));
            } else {
              handler.resolve(msg.embeddings);
            }
          }
        } catch (e) {
          // ignore parse error of partial lines
        }
      }
    });

    // Wait for initialization
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const request = { texts, request_id: requestId };
      try {
        this.pythonProcess.stdin.write(JSON.stringify(request) + '\n');
      } catch (e) {
        reject(e);
        return;
      }
      const timeout = setTimeout(() => {
        if (this.pendingResolvers.has(requestId)) {
          this.pendingResolvers.get(requestId)!.reject(new Error('Embedding generation timeout'));
          this.pendingResolvers.delete(requestId);
        }
      }, 30000);
      this.pendingResolvers.set(requestId, { resolve, reject, timeout });
    });
  }

  async processDocument(pageId: number, text: string, lang: string = 'zh'): Promise<void> {
    try {
      // Split text into chunks
      const chunks = this.splitTextIntoChunks(text);
      
      // Process in batches
      for (let i = 0; i < chunks.length; i += this.config.batchSize) {
        const batch = chunks.slice(i, i + this.config.batchSize);
        const texts = batch.map(chunk => chunk.content);
        
        // Generate embeddings
        const embeddings = await this.generateEmbeddings(texts);
        
        // Store in database
        const chunkData = batch.map((chunk, idx) => ({
          pageId,
          chunkIndex: chunk.index,
          content: chunk.content,
          tokens: chunk.content.length,
          embedding: embeddings[idx],
          lang
        }));
        
        await this.storeChunkEmbeddings(chunkData);
        
        this.emit('progress', {
          pageId,
          processed: Math.min(i + this.config.batchSize, chunks.length),
          total: chunks.length
        });
      }
      
      // Update page-level embedding (average of chunks)
      await this.updatePageEmbedding(pageId);
      
    } catch (error) {
      Logger.error(`Failed to process document ${pageId}:`, error);
      throw error;
    }
  }

  private splitTextIntoChunks(text: string, chunkSize: number = 512, overlap: number = 50): Array<{content: string, index: number}> {
    const sentences = text.match(/[^。！？.!?]+[。！？.!?]+/g) || [text];
    const chunks: Array<{content: string, index: number}> = [];
    let currentChunk: string[] = [];
    let currentLength = 0;
    let chunkIndex = 0;

    for (const sentence of sentences) {
      const sentenceLength = sentence.length;

      if (currentLength + sentenceLength > chunkSize && currentChunk.length > 0) {
        // Save current chunk
        chunks.push({
          content: currentChunk.join(' '),
          index: chunkIndex++
        });

        // Start new chunk with overlap
        const overlapSentences: string[] = [];
        let overlapLength = 0;
        
        for (let i = currentChunk.length - 1; i >= 0; i--) {
          const sent = currentChunk[i];
          if (overlapLength + sent.length <= overlap) {
            overlapSentences.unshift(sent);
            overlapLength += sent.length;
          } else {
            break;
          }
        }

        currentChunk = [...overlapSentences, sentence];
        currentLength = overlapLength + sentenceLength;
      } else {
        currentChunk.push(sentence);
        currentLength += sentenceLength;
      }
    }

    // Save last chunk
    if (currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.join(' '),
        index: chunkIndex
      });
    }

    return chunks;
  }

  private async storeChunkEmbeddings(chunks: Array<ChunkData & { embedding: number[], tokens: number }>): Promise<void> {
    const values = chunks.map(chunk => ({
      pageId: chunk.pageId,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      tokens: chunk.tokens,
      lang: chunk.lang || 'zh',
      embedding: chunk.embedding
    }));

    // Use raw SQL for vector insertion
    for (const value of values) {
      if (!Array.isArray(value.embedding) || value.embedding.length !== this.config.dimension) {
        throw new Error(`Embedding dimension mismatch: expected ${this.config.dimension}, got ${value.embedding?.length}`);
      }
      const embeddingLiteral = `[${value.embedding.join(',')}]`;
      await this.prisma.$executeRaw`
        INSERT INTO "SearchChunk" 
        ("pageId", "chunkIndex", content, tokens, lang, embedding)
        VALUES (${value.pageId}, ${value.chunkIndex}, ${value.content}, 
                ${value.tokens}, ${value.lang}, ${embeddingLiteral}::vector(${this.config.dimension}))
        ON CONFLICT ("pageId", "chunkIndex") 
        DO UPDATE SET 
          content = EXCLUDED.content,
          tokens = EXCLUDED.tokens,
          embedding = EXCLUDED.embedding,
          "updatedAt" = CURRENT_TIMESTAMP
      `;
    }
  }

  private async updatePageEmbedding(pageId: number): Promise<void> {
    try {
      // Skip if SearchIndex doesn't exist
      const exists: Array<{ to_regclass: string | null }> = await this.prisma.$queryRaw`
        SELECT to_regclass('public.SearchIndex')
      `;
      if (!exists || exists[0]?.to_regclass == null) {
        Logger.debug('SearchIndex table not found, skipping page embedding update');
        return;
      }

      // Calculate average embedding from chunks and update
      await this.prisma.$queryRaw<any[]>`
        WITH chunk_embeddings AS (
          SELECT embedding 
          FROM "SearchChunk" 
          WHERE "pageId" = ${pageId}
        ),
        avg_embedding AS (
          SELECT AVG(embedding) as avg_emb
          FROM chunk_embeddings
        )
        UPDATE "SearchIndex"
        SET embedding = (SELECT avg_emb FROM avg_embedding),
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "pageId" = ${pageId}
      `;
    } catch (e) {
      Logger.debug('Skipping updatePageEmbedding due to missing table or other error');
    }
  }

  async processMultipleDocuments(documents: Array<{id: number, text: string, lang?: string}>): Promise<void> {
    const tasks = documents.map(doc => 
      this.limit(() => this.processDocument(doc.id, doc.text, doc.lang || 'zh'))
    );
    
    await Promise.all(tasks);
  }

  async hybridSearch(query: string, options: {
    ftsWeight?: number;
    vectorWeight?: number;
    limit?: number;
    lang?: string;
  } = {}): Promise<any[]> {
    const {
      ftsWeight = 0.6,
      vectorWeight = 0.4,
      limit = 20,
      lang = 'zh'
    } = options;

    // Generate query embedding
    const [queryEmbedding] = await this.generateEmbeddings([query]);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    // Execute hybrid search
    const results = await this.prisma.$queryRaw`
      SELECT * FROM hybrid_search(
        ${query}::text,
        ${embeddingStr}::vector(${this.config.dimension}),
        ${ftsWeight}::float,
        ${vectorWeight}::float,
        ${limit}::int
      )
    `;

    return results as any[];
  }

  async checkEmbeddingCoverage(): Promise<any> {
    const coverage = await this.prisma.$queryRaw`
      SELECT * FROM check_embedding_coverage()
    `;
    return coverage;
  }

  async cleanup(): Promise<void> {
    if (this.pythonProcess) {
      this.pythonProcess.kill();
      this.pythonProcess = null;
    }
    this.isInitialized = false;
    for (const [, h] of this.pendingResolvers) {
      clearTimeout(h.timeout);
      h.reject(new Error('Embedding service cleaned up'));
    }
    this.pendingResolvers.clear();
  }
}

// Factory function
export function createEmbeddingService(prisma: PrismaClient, config?: Partial<EmbeddingConfig>): EmbeddingService {
  return new EmbeddingService(prisma, config);
}