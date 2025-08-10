import { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { ResponseBuilder } from '../types/api.js';

export function validate(schema: {
  body?: z.ZodSchema;
  query?: z.ZodSchema;
  params?: z.ZodSchema;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (schema.body) {
        req.body = await schema.body.parseAsync(req.body);
      }
      if (schema.query) {
        req.query = await schema.query.parseAsync(req.query);
      }
      if (schema.params) {
        req.params = await schema.params.parseAsync(req.params);
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json(
          ResponseBuilder.error(
            'VALIDATION_ERROR',
            'Invalid request data',
            error.errors
          )
        );
      }
      next(error);
    }
  };
}

// 验证模式定义
export const schemas = {
  pagination: z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
  }),
  
  searchQuery: z.object({
    q: z.string().min(1).max(200),
    tags: z.string().optional().transform(val => 
      val ? val.split(',').filter(Boolean) : undefined
    ),
    category: z.string().optional(),
    sort: z.enum(['relevance', 'rating', 'date']).default('relevance'),
  }),
  
  pageListQuery: z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    tags: z.string().optional().transform(val => 
      val ? val.split(',').filter(Boolean) : undefined
    ),
    category: z.enum(['scp', 'goi', 'story', 'translation', 'art']).optional(),
    sort: z.enum(['rating', 'date', 'votes']).default('rating'),
  }),
  
  identifier: z.object({
    identifier: z.string().min(1),
  }),

  userId: z.object({
    userId: z.coerce.number().min(1),
  }),
  
  tagSearch: z.object({
    tags: z.string().min(1).transform(val => 
      val.split(',').filter(Boolean)
    ),
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
  }),
};