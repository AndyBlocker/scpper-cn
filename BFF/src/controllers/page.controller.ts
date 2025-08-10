import { Request, Response } from 'express';
import { PageService, NotFoundError } from '../services/page.service.js';
import { ResponseBuilder } from '../types/api.js';
import { asyncHandler } from '../middleware/error.middleware.js';

export class PageController {
  constructor(private pageService: PageService) {}

  getPageDetail = asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = req.params;
    
    try {
      const pageDetail = await this.pageService.getPageDetail(identifier);
      res.json(ResponseBuilder.success(pageDetail));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json(ResponseBuilder.error('NOT_FOUND', error.message));
      } else {
        throw error;
      }
    }
  });

  getPageList = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit, tags, category, sort } = req.query as any;
    
    const pageList = await this.pageService.getPageList({
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      tags: tags ? tags.split(',').filter(Boolean) : undefined,
      category,
      sort: sort || 'rating',
    });

    res.json(ResponseBuilder.success(pageList));
  });

  getPageVersions = asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = req.params;
    const { page, limit } = req.query as any;
    
    try {
      const versions = await this.pageService.getPageVersions(identifier, {
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
      });
      res.json(ResponseBuilder.success(versions));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json(ResponseBuilder.error('NOT_FOUND', error.message));
      } else {
        throw error;
      }
    }
  });

  getPageVotes = asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = req.params;
    const { page, limit, direction } = req.query as any;
    
    try {
      const votes = await this.pageService.getPageVotes(identifier, {
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
        direction: direction !== undefined ? parseInt(direction) : undefined,
      });
      res.json(ResponseBuilder.success(votes));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json(ResponseBuilder.error('NOT_FOUND', error.message));
      } else {
        throw error;
      }
    }
  });

  getPageRevisions = asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = req.params;
    const { page, limit, type } = req.query as any;
    
    try {
      const revisions = await this.pageService.getPageRevisions(identifier, {
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
        type: type || undefined,
      });
      res.json(ResponseBuilder.success(revisions));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json(ResponseBuilder.error('NOT_FOUND', error.message));
      } else {
        throw error;
      }
    }
  });

  getPageStats = asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = req.params;
    
    try {
      const stats = await this.pageService.getPageStats(identifier);
      res.json(ResponseBuilder.success(stats));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json(ResponseBuilder.error('NOT_FOUND', error.message));
      } else {
        throw error;
      }
    }
  });

  getPageVotingHistory = asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = req.params;
    
    try {
      const history = await this.pageService.getPageVotingHistory(identifier);
      res.json(ResponseBuilder.success(history));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json(ResponseBuilder.error('NOT_FOUND', error.message));
      } else {
        throw error;
      }
    }
  });

  getRandomPages = asyncHandler(async (req: Request, res: Response) => {
    const { limit, tags, category, minRating, maxRating } = req.query as any;
    
    const randomPages = await this.pageService.getRandomPages({
      limit: limit ? parseInt(limit) : 5,
      tags: tags ? tags.split(',').filter(Boolean) : undefined,
      category,
      minRating: minRating ? parseInt(minRating) : undefined,
      maxRating: maxRating ? parseInt(maxRating) : undefined,
    });

    res.json(ResponseBuilder.success(randomPages));
  });
}