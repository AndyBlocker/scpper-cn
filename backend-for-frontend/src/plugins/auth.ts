import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: any, reply: any) => Promise<void>
    requireAdmin: (request: any, reply: any) => Promise<void>
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  // JWT 插件会自动添加 user 装饰器，这里不需要手动添加
  
  // JWT 验证装饰器
  fastify.decorate('authenticate', async (request: any, reply: any) => {
    try {
      const token = request.headers.authorization?.replace('Bearer ', '')
      
      if (!token) {
        // 对于大部分只读接口，允许匿名访问
        return
      }
      
      // 使用 jwtVerify 方法，它会自动设置 request.user
      await request.jwtVerify()
    } catch (error) {
      reply.status(401)
      throw new Error('Invalid or expired token')
    }
  })
  
  // 管理员权限检查
  fastify.decorate('requireAdmin', async (request: any, reply: any) => {
    await fastify.authenticate(request, reply)
    
    if (!request.user || request.user.role !== 'admin') {
      reply.status(403)
      throw new Error('Admin access required')
    }
  })
  
  // 简单的API密钥认证（用于网页访问控制）
  fastify.addHook('preHandler', async (request, reply) => {
    // 对于某些敏感接口，检查是否来自允许的来源
    if (process.env.NODE_ENV === 'production') {
      const referer = request.headers.referer
      const userAgent = request.headers['user-agent']
      
      // 简单的来源检查（可以根据需求调整）
      if (!referer?.includes(process.env.ALLOWED_DOMAIN || 'localhost')) {
        if (request.url.startsWith('/api/admin/')) {
          reply.status(403)
          throw new Error('Access denied')
        }
      }
    }
  })
}

export default fp(authPlugin)