#!/bin/bash

# SCPPER-CN 数据库配置辅助脚本

echo "🗄️ SCPPER-CN 数据库配置向导"
echo "=================================="

# 检查PostgreSQL是否安装
if ! command -v psql &> /dev/null; then
    echo "❌ PostgreSQL未安装，请先安装PostgreSQL"
    exit 1
fi

echo "✅ PostgreSQL已安装: $(psql --version | head -n1)"

# 获取用户输入
echo ""
echo "请提供数据库配置信息:"

read -p "数据库主机 (默认: localhost): " DB_HOST
DB_HOST=${DB_HOST:-localhost}

read -p "数据库端口 (默认: 5432): " DB_PORT
DB_PORT=${DB_PORT:-5432}

read -p "数据库名称 (默认: scpper_cn): " DB_NAME
DB_NAME=${DB_NAME:-scpper_cn}

read -p "数据库用户名 (默认: scpper_user): " DB_USER
DB_USER=${DB_USER:-scpper_user}

read -s -p "数据库密码: " DB_PASSWORD
echo ""

if [ -z "$DB_PASSWORD" ]; then
    echo "❌ 密码不能为空"
    exit 1
fi

# 构建数据库URL
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

echo ""
echo "📋 配置信息:"
echo "主机: $DB_HOST"
echo "端口: $DB_PORT"
echo "数据库: $DB_NAME"  
echo "用户: $DB_USER"
echo "密码: [已隐藏]"

echo ""
read -p "是否创建数据库和用户? (y/N): " CREATE_DB

if [[ $CREATE_DB =~ ^[Yy]$ ]]; then
    echo ""
    echo "🔨 创建数据库和用户..."
    
    # 检查是否有postgres用户权限
    if sudo -u postgres psql -c "\q" 2>/dev/null; then
        echo "使用postgres用户创建数据库..."
        
        sudo -u postgres psql << EOF
-- 创建数据库 (如果不存在)
SELECT 'CREATE DATABASE $DB_NAME' 
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')\gexec

-- 创建用户 (如果不存在)
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
        CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';
    END IF;
END
\$\$;

-- 授权
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
ALTER USER $DB_USER CREATEDB;
EOF
        
        if [ $? -eq 0 ]; then
            echo "✅ 数据库和用户创建成功"
        else
            echo "❌ 数据库创建失败"
            exit 1
        fi
    else
        echo "⚠️ 无法使用postgres用户，请手动创建数据库:"
        echo "sudo -u postgres psql -c \"CREATE DATABASE $DB_NAME;\""
        echo "sudo -u postgres psql -c \"CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';\""
        echo "sudo -u postgres psql -c \"GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;\""
    fi
fi

# 测试连接
echo ""
echo "🔍 测试数据库连接..."
if psql "$DATABASE_URL" -c "SELECT 1;" &>/dev/null; then
    echo "✅ 数据库连接成功"
else
    echo "❌ 数据库连接失败，请检查配置"
    echo "连接字符串: $DATABASE_URL"
    exit 1
fi

# 更新.env文件
echo ""
echo "📝 更新.env配置文件..."

if [ -f ".env" ]; then
    # 备份原文件
    cp .env .env.backup.$(date +%Y%m%d_%H%M%S)
    echo "原配置已备份"
fi

# 更新DATABASE_URL
if [ -f ".env" ]; then
    # 替换现有的DATABASE_URL
    sed -i.bak "s|^DATABASE_URL=.*|DATABASE_URL=$DATABASE_URL|" .env
    rm .env.bak 2>/dev/null
else
    # 创建基本的.env文件
    cat > .env << EOF
# SCPPER-CN 环境配置
CROM_API_URL=https://apiv1.crom.avn.sh/graphql
TARGET_SITE_URL=http://scp-wiki-cn.wikidot.com
DATABASE_URL=$DATABASE_URL
MAX_REQUESTS_PER_SECOND=1.8
BATCH_SIZE=10
LOG_LEVEL=info
EOF
fi

echo "✅ .env文件已更新"

# 初始化数据库结构
echo ""
read -p "是否初始化数据库结构? (Y/n): " INIT_DB
if [[ ! $INIT_DB =~ ^[Nn]$ ]]; then
    echo ""
    echo "🏗️ 初始化数据库结构..."
    
    if npx prisma migrate deploy; then
        echo "✅ 数据库结构初始化成功"
        
        if npx prisma generate; then
            echo "✅ Prisma客户端生成成功"
        else
            echo "⚠️ Prisma客户端生成失败"
        fi
    else
        echo "❌ 数据库结构初始化失败"
        exit 1
    fi
fi

# 验证安装
echo ""
echo "🎉 数据库配置完成!"
echo "=================================="
echo ""
echo "📊 配置摘要:"
echo "数据库URL: $DATABASE_URL"
echo "配置文件: .env"
echo ""
echo "🚀 下一步:"
echo "1. 运行同步脚本: node src/sync/database-sync.js"
echo "2. 查看服务状态: ./monitor.sh"
echo "3. 运行用户分析: node src/analysis/user-analytics.js"
echo ""
echo "🔍 验证数据库:"
echo "psql \$DATABASE_URL -c \"SELECT COUNT(*) FROM pages;\""