import { Request, Response } from 'express';
import { ResponseBuilder } from '../types/api.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { UserService, NotFoundError } from '../services/user.service.js';

export class UserController {
  constructor(private userService: UserService) {}

  getUserList = asyncHandler(async (req: Request, res: Response) => {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const sort = req.query.sort as string || 'karma';

    const result = await this.userService.getUserList({
      page,
      limit,
      sort: sort as 'karma' | 'contributions' | 'latest',
    });

    res.json(ResponseBuilder.success(result));
  });

  getUserDetail = asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = req.params;
    
    try {
      const user = await this.userService.getUserDetail(identifier);
      res.json(ResponseBuilder.success(user));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json(ResponseBuilder.error('NOT_FOUND', 'User not found'));
        return;
      }
      throw error;
    }
  });

  getUserStats = asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = req.params;
    
    try {
      const stats = await this.userService.getUserStats(identifier);
      res.json(ResponseBuilder.success(stats));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json(ResponseBuilder.error('NOT_FOUND', 'User not found'));
        return;
      }
      throw error;
    }
  });

  getUserAttributions = asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    
    try {
      const attributions = await this.userService.getUserAttributions(identifier, {
        page,
        limit,
      });
      res.json(ResponseBuilder.success(attributions));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json(ResponseBuilder.error('NOT_FOUND', 'User not found'));
        return;
      }
      throw error;
    }
  });

  getUserVotes = asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    
    try {
      const votes = await this.userService.getUserVotes(identifier, {
        page,
        limit,
      });
      res.json(ResponseBuilder.success(votes));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json(ResponseBuilder.error('NOT_FOUND', 'User not found'));
        return;
      }
      throw error;
    }
  });

  getUserActivity = asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    
    try {
      const activity = await this.userService.getUserActivity(identifier, {
        page,
        limit,
      });
      res.json(ResponseBuilder.success(activity));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json(ResponseBuilder.error('NOT_FOUND', 'User not found'));
        return;
      }
      throw error;
    }
  });

  getUserRatingHistory = asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = req.params;
    
    try {
      const history = await this.userService.getUserRatingHistory(identifier);
      res.json(ResponseBuilder.success(history));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json(ResponseBuilder.error('NOT_FOUND', 'User not found'));
        return;
      }
      throw error;
    }
  });
}