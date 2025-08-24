# SCPper CN 前端

## 开发环境

```bash
# 安装依赖
npm install

# 启动开发服务器（需要本地运行 BFF 服务）
BFF_BASE=http://localhost:4396 npm run dev
```

## 生产环境部署

### 方式一：使用反向代理（推荐）

1. **构建前端**
```bash
npm run build
```

2. **启动前端服务**
```bash
# 使用 PM2
pm2 start ecosystem.config.cjs

# 或直接运行
npm run start
```

3. **配置 Nginx 反向代理**

将 `/api/*` 请求转发到 BFF 服务（localhost:4396）：

```nginx
server {
    listen 80;
    server_name scpper.mer.run;

    # 前端
    location / {
        proxy_pass http://localhost:9876;
    }

    # API 反向代理
    location /api/ {
        rewrite ^/api/(.*)$ /$1 break;
        proxy_pass http://localhost:4396;
    }
}
```

### 方式二：直接使用 BFF 地址

如果 BFF 服务可以公开访问，可以直接配置：

```bash
# 构建时指定 BFF 地址
BFF_BASE=https://scpper.mer.run:4396 npm run build
```

## 环境变量

- `BFF_BASE`: BFF 服务地址
  - 开发环境：`http://localhost:4396`
  - 生产环境（反向代理）：`/api`
  - 生产环境（直接访问）：`https://scpper.mer.run:4396`

## 常见问题

### 1. API 请求一直待处理

**问题**：前端在浏览器中请求 `localhost:4396`，但这指向的是用户的本地机器，而不是服务器。

**解决**：
- 使用反向代理将 `/api` 转发到 BFF 服务
- 或者让 BFF 服务监听公网地址并配置 CORS

### 2. 页面导航不更新内容

**解决**：页面组件已配置 `definePageMeta({ key: route => route.fullPath })`，确保路由变化时重新渲染。

### 3. Hydration 错误

**解决**：所有页面组件都有稳定的根元素，条件渲染在内部。

## 端口说明

- 前端 SSR：9876
- BFF 服务：4396
- 后端 API：5036