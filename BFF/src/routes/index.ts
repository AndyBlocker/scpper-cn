import { Express, Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { CacheService } from '../services/cache.service.js';
import { PageService } from '../services/page.service.js';
import { SearchService } from '../services/search.service.js';
import { StatsService } from '../services/stats.service.js';
import { UserService } from '../services/user.service.js';
import { PageController } from '../controllers/page.controller.js';
import { SearchController } from '../controllers/search.controller.js';
import { StatsController } from '../controllers/stats.controller.js';
import { UserController } from '../controllers/user.controller.js';
import { createPageRoutes } from './page.routes.js';
import { createSearchRoutes } from './search.routes.js';
import { createStatsRoutes } from './stats.routes.js';
import { createUserRoutes } from './user.routes.js';
import { ResponseBuilder } from '../types/api.js';
import { config } from '../config/index.js';

export function setupRoutes(
  app: Express,
  prisma: PrismaClient,
  cache: CacheService
) {
  // 创建服务实例
  const pageService = new PageService(prisma, cache);
  const searchService = new SearchService(prisma, cache);
  const statsService = new StatsService(prisma, cache);
  const userService = new UserService(prisma, cache);

  // 创建控制器实例
  const pageController = new PageController(pageService);
  const searchController = new SearchController(searchService);
  const statsController = new StatsController(statsService);
  const userController = new UserController(userService);

  // 创建路由
  const pageRoutes = createPageRoutes(pageController);
  const searchRoutes = createSearchRoutes(searchController);
  const statsRoutes = createStatsRoutes(statsController);
  const userRoutes = createUserRoutes(userController);

  // 注册路由
  app.use('/pages', pageRoutes);
  app.use('/search', searchRoutes);
  app.use('/stats', statsRoutes);
  app.use('/users', userRoutes);

  // 元数据路由
  const metaRouter = Router();
  
  metaRouter.get('/tags', (req, res) => {
    // TODO: Implement get all tags
    res.json(ResponseBuilder.success({
      message: 'Get all tags endpoint not yet implemented',
    }));
  });

  metaRouter.get('/categories', (req, res) => {
    const categories = [
      { id: 'scp', name: 'SCP', description: 'SCP项目' },
      { id: 'goi', name: 'GOI格式', description: '关注组织格式' },
      { id: 'story', name: '故事', description: '原创故事' },
      { id: 'translation', name: '译文', description: '翻译作品' },
      { id: 'art', name: '艺术作品', description: '艺术创作' },
    ];
    res.json(ResponseBuilder.success(categories));
  });

  metaRouter.get('/config', (req, res) => {
    const siteConfig = {
      siteName: 'SCP中文维基',
      version: '2.0.0',
      apiVersion: config.api.version,
      supportedCategories: ['scp', 'goi', 'story', 'translation', 'art'],
      maxSearchResults: 100,
      defaultPageSize: 20,
    };
    res.json(ResponseBuilder.success(siteConfig));
  });

  app.use('/meta', metaRouter);

  // API根路径
  app.get('/', (req, res) => {
    res.json(ResponseBuilder.success({
      message: 'SCPPER-CN BFF API',
      version: config.api.version,
      endpoints: {
        pages: '/pages',
        search: '/search',
        stats: '/stats',
        users: '/users',
        meta: '/meta',
      },
      documentation: 'https://docs.scpper.cn/api',
    }));
  });

  // 404处理
  app.use('*', (req, res) => {
    res.status(404).json(
      ResponseBuilder.error('NOT_FOUND', `Endpoint ${req.originalUrl} not found`)
    );
  });
}