import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

interface MetricsData {
  requests: {
    total: number
    success: number
    error: number
    byStatus: Record<number, number>
    byRoute: Record<string, number>
  }
  responseTime: {
    sum: number
    count: number
    avg: number
  }
  uptime: number
  memory: NodeJS.MemoryUsage
}

declare module 'fastify' {
  interface FastifyInstance {
    metrics: MetricsData
  }
}

const metricsPlugin: FastifyPluginAsync = async (fastify) => {
  // 初始化指标数据
  const metrics: MetricsData = {
    requests: {
      total: 0,
      success: 0,
      error: 0,
      byStatus: {},
      byRoute: {}
    },
    responseTime: {
      sum: 0,
      count: 0,
      avg: 0
    },
    uptime: Date.now(),
    memory: process.memoryUsage()
  }
  
  fastify.decorate('metrics', metrics)
  
  // 请求监控钩子
  fastify.addHook('onRequest', async (request) => {
    (request as any).startTime = Date.now()
    metrics.requests.total++
    
    const route = (request as any).routeOptions?.url || request.url.split('?')[0]
    metrics.requests.byRoute[route] = (metrics.requests.byRoute[route] || 0) + 1
  })
  
  // 响应监控钩子
  fastify.addHook('onResponse', async (request, reply) => {
    const responseTime = Date.now() - (request as any).startTime
    
    // 更新响应时间统计
    metrics.responseTime.sum += responseTime
    metrics.responseTime.count++
    metrics.responseTime.avg = metrics.responseTime.sum / metrics.responseTime.count
    
    // 更新状态码统计
    const status = reply.statusCode
    metrics.requests.byStatus[status] = (metrics.requests.byStatus[status] || 0) + 1
    
    // 更新成功/失败统计
    if (status >= 200 && status < 400) {
      metrics.requests.success++
    } else {
      metrics.requests.error++
    }
    
    // 定期更新内存使用情况
    if (metrics.requests.total % 100 === 0) {
      metrics.memory = process.memoryUsage()
    }
  })
  
  // 检查是否允许访问metrics（仅内网或开发环境）
  const isMetricsAllowed = (request: any) => {
    const env = process.env.NODE_ENV
    if (env === 'development') return true
    
    // 生产环境检查IP白名单或token
    const clientIp = request.ip
    const allowedIPs = process.env.METRICS_ALLOWED_IPS?.split(',') || ['127.0.0.1', '::1']
    const validToken = process.env.METRICS_TOKEN
    const providedToken = request.headers['x-metrics-token']
    
    return allowedIPs.includes(clientIp) || (validToken && validToken === providedToken)
  }

  // Prometheus 格式的指标端点
  fastify.get('/metrics', {
    preHandler: async (request, reply) => {
      if (!isMetricsAllowed(request)) {
        reply.status(403)
        return { error: 'Access denied' }
      }
    }
  }, async () => {
    const now = Date.now()
    const uptimeSeconds = Math.floor((now - metrics.uptime) / 1000)
    
    return `# HELP scpper_http_requests_total Total number of HTTP requests
# TYPE scpper_http_requests_total counter
scpper_http_requests_total ${metrics.requests.total}

# HELP scpper_http_requests_success_total Total number of successful HTTP requests
# TYPE scpper_http_requests_success_total counter
scpper_http_requests_success_total ${metrics.requests.success}

# HELP scpper_http_requests_error_total Total number of failed HTTP requests
# TYPE scpper_http_requests_error_total counter
scpper_http_requests_error_total ${metrics.requests.error}

# HELP scpper_http_request_duration_avg Average HTTP request duration
# TYPE scpper_http_request_duration_avg gauge
scpper_http_request_duration_avg ${metrics.responseTime.avg}

# HELP scpper_process_uptime_seconds Process uptime in seconds
# TYPE scpper_process_uptime_seconds gauge
scpper_process_uptime_seconds ${uptimeSeconds}

# HELP scpper_process_memory_bytes Memory usage in bytes
# TYPE scpper_process_memory_bytes gauge
scpper_process_memory_bytes{type="rss"} ${metrics.memory.rss}
scpper_process_memory_bytes{type="heapTotal"} ${metrics.memory.heapTotal}
scpper_process_memory_bytes{type="heapUsed"} ${metrics.memory.heapUsed}
scpper_process_memory_bytes{type="external"} ${metrics.memory.external}
`
  })
  
  // JSON 格式的指标端点（用于调试）
  fastify.get('/api/metrics', {
    preHandler: async (request, reply) => {
      if (!isMetricsAllowed(request)) {
        reply.status(403)
        return { error: 'Access denied' }
      }
    }
  }, async () => {
    return {
      ...metrics,
      uptime: Date.now() - metrics.uptime,
      timestamp: new Date().toISOString()
    }
  })
}

export default fp(metricsPlugin)