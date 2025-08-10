import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { config } from './config/index.js';
import { createPrismaClient, connectDatabase } from './config/database.js';
import { createRedisClient, connectRedis } from './config/redis.js';
import { CacheService } from './services/cache.service.js';
import { errorHandler } from './middleware/error.middleware.js';
import { loggingMiddleware } from './middleware/logging.middleware.js';
import { rateLimiters } from './middleware/rateLimit.middleware.js';
import { setupRoutes } from './routes/index.js';
import { setupMetrics } from './utils/metrics.js';
import { logger } from './utils/logger.js';
import { ResponseBuilder } from './types/api.js';

export class App {
  private app: Express;
  private prisma: ReturnType<typeof createPrismaClient>;
  private redis: ReturnType<typeof createRedisClient>;
  private cache: CacheService;

  constructor() {
    this.app = express();
    this.prisma = createPrismaClient();
    this.redis = createRedisClient();
    this.cache = new CacheService();
  }

  async initialize() {
    try {
      // 安全中间件
      this.app.use(helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
          },
        },
        crossOriginEmbedderPolicy: false,
      }));

      // CORS配置
      this.app.use(cors({
        origin: config.nodeEnv === 'production' ? [
          'https://scpper.mer.run',
          'https://www.scpper.mer.run'
        ] : true,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      }));

      // 通用中间件
      this.app.use(compression());
      this.app.use(express.json({ limit: '10mb' }));
      this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
      
      // 信任代理 (对于nginx反向代理)
      this.app.set('trust proxy', 1);
      
      // 日志中间件
      this.app.use(loggingMiddleware);
      
      // 通用限流中间件
      this.app.use(rateLimiters.api);
      
      // 健康检查端点
      this.app.get('/health', async (req, res) => {
        const health = {
          status: 'ok',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          environment: config.nodeEnv,
          services: {
            database: false,
            redis: false,
          },
        };

        try {
          // 检查数据库连接
          await this.prisma.$queryRaw`SELECT 1`;
          health.services.database = true;
        } catch (error) {
          logger.error('Database health check failed:', error);
        }

        try {
          // 检查Redis连接 (如果启用)
          if (this.redis) {
            await this.redis.ping();
            health.services.redis = true;
          } else {
            // Redis未启用或不可用时，不视为错误
            health.services.redis = false;
          }
        } catch (error) {
          logger.warn('Redis health check failed:', error);
          health.services.redis = false;
        }

        // 只要数据库可用就认为服务健康，Redis是可选的
        const overallStatus = health.services.database;
        res.status(overallStatus ? 200 : 503).json(
          ResponseBuilder.success(health)
        );
      });

      // 就绪检查端点
      this.app.get('/ready', async (req, res) => {
        try {
          await this.prisma.$queryRaw`SELECT 1`;
          
          // Redis是可选的，不影响就绪状态
          let redisStatus = 'not_configured';
          if (this.redis) {
            try {
              await this.redis.ping();
              redisStatus = 'connected';
            } catch {
              redisStatus = 'disconnected';
            }
          }
          
          res.json(ResponseBuilder.success({ 
            status: 'ready',
            redis: redisStatus,
            cache: this.cache.getStatus(),
          }));
        } catch (error) {
          res.status(503).json(
            ResponseBuilder.error('SERVICE_UNAVAILABLE', 'Service not ready')
          );
        }
      });

      // 版本信息端点
      this.app.get('/version', (req, res) => {
        res.json(ResponseBuilder.success({
          version: '1.0.0',
          buildDate: new Date().toISOString(),
          nodeVersion: process.version,
          environment: config.nodeEnv,
        }));
      });

      // 缓存状态端点 (仅开发环境)
      if (config.nodeEnv === 'development') {
        this.app.get('/cache-status', (req, res) => {
          res.json(ResponseBuilder.success(this.cache.getStatus()));
        });
      }
      
      // 设置监控 (必须在路由之前)
      if (config.metrics.enabled) {
        setupMetrics(this.app);
        logger.info('Metrics enabled on /metrics endpoint');
      }
      
      // API路由
      setupRoutes(this.app, this.prisma, this.cache);
      
      // 错误处理中间件 (必须在最后)
      this.app.use(errorHandler);
      
      // 连接数据库
      await connectDatabase();
      logger.info('Database connected successfully');
      
      // 尝试连接Redis (可选)
      try {
        await connectRedis();
        logger.info('Redis connected successfully');
      } catch (error) {
        logger.warn('Redis connection failed, continuing with memory cache fallback:', error);
      }
      
      logger.info('Application initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize application:', error);
      throw error;
    }
  }

  async start() {
    await this.initialize();
    
    return new Promise<void>((resolve) => {
      const server = this.app.listen(config.port, '0.0.0.0', () => {
        logger.info(`BFF service started on port ${config.port}`);
        logger.info(`API available at http://localhost:${config.port}${config.api.prefix}`);
        logger.info(`Health check at http://localhost:${config.port}/health`);
        logger.info(`Metrics at http://localhost:${config.port}/metrics`);
        resolve();
      });

      // 优雅关闭
      server.on('error', (error) => {
        logger.error('Server error:', error);
        throw error;
      });
    });
  }

  async stop() {
    try {
      await this.prisma.$disconnect();
      await this.redis.disconnect();
      logger.info('Service stopped gracefully');
    } catch (error) {
      logger.error('Error during shutdown:', error);
      throw error;
    }
  }

  getApp(): Express {
    return this.app;
  }
}