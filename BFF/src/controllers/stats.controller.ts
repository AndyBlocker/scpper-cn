import { Request, Response } from 'express';
import { StatsService } from '../services/stats.service.js';
import { ResponseBuilder } from '../types/api.js';
import { asyncHandler } from '../middleware/error.middleware.js';

export class StatsController {
  constructor(private statsService: StatsService) {}

  getSiteStats = asyncHandler(async (req: Request, res: Response) => {
    const siteStats = await this.statsService.getSiteStats();
    res.json(ResponseBuilder.success(siteStats));
  });

  getSeriesStats = asyncHandler(async (req: Request, res: Response) => {
    // TODO: Implement series stats endpoint
    res.json(ResponseBuilder.success({
      message: 'Series stats endpoint not yet implemented',
    }));
  });

  getSeriesDetail = asyncHandler(async (req: Request, res: Response) => {
    const { number } = req.params;
    
    // TODO: Implement series detail endpoint
    res.json(ResponseBuilder.success({
      message: 'Series detail endpoint not yet implemented',
      seriesNumber: number,
    }));
  });

  getInterestingStats = asyncHandler(async (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const category = req.query.category as string;
    const random = req.query.random === 'true';
    const randomPerCategory = req.query.randomPerCategory === 'true';
    
    const interestingStats = await this.statsService.getInterestingStats({
      limit,
      category,
      random,
      randomPerCategory
    });
    res.json(ResponseBuilder.success(interestingStats));
  });

  getTrendingStats = asyncHandler(async (req: Request, res: Response) => {
    // TODO: Implement trending stats endpoint  
    res.json(ResponseBuilder.success({
      message: 'Trending stats endpoint not yet implemented',
    }));
  });


  getTagStats = asyncHandler(async (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 100;
    
    // TODO: Implement tag stats endpoint
    res.json(ResponseBuilder.success({
      message: 'Tag stats endpoint not yet implemented',
      limit,
    }));
  });
}