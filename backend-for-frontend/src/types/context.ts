import type { PrismaClient } from '@prisma/client'
import type Redis from 'ioredis'
import type { FastifyLoggerInstance } from 'fastify'
import type { MercuriusContext } from 'mercurius'

export interface Context extends MercuriusContext {
  prisma: PrismaClient
  redis?: Redis
  user?: any
  logger: FastifyLoggerInstance
}