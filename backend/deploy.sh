#!/bin/bash

# SCPPER-CN 服务器部署脚本
# 用于在新服务器上快速部署SCPPER-CN系统

set -e  # 遇到错误立即退出

echo "🚀 SCPPER-CN 服务器部署开始"
echo "=================================="

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查运行环境
check_environment() {
    print_status "检查部署环境..."
    
    # 检查Node.js版本
    if ! command -v node &> /dev/null; then
        print_error "Node.js 未安装，请先安装Node.js 18+"
        exit 1
    fi
    
    NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        print_error "Node.js版本过低，需要18+，当前版本: $(node --version)"
        exit 1
    fi
    print_success "Node.js版本检查通过: $(node --version)"
    
    # 检查npm
    if ! command -v npm &> /dev/null; then
        print_error "npm 未安装"
        exit 1
    fi
    print_success "npm版本: $(npm --version)"
    
    # 检查git
    if ! command -v git &> /dev/null; then
        print_error "git 未安装"
        exit 1
    fi
    print_success "git版本: $(git --version)"
}

# 安装依赖
install_dependencies() {
    print_status "安装项目依赖..."
    
    if [ ! -f "package.json" ]; then
        print_error "未找到package.json文件，请确保在backend目录中运行"
        exit 1
    fi
    
    npm install
    print_success "依赖安装完成"
}

# 检查和安装系统依赖
install_system_dependencies() {
    print_status "检查系统依赖..."
    
    # 检查PostgreSQL
    if command -v psql &> /dev/null; then
        print_success "PostgreSQL已安装: $(psql --version | head -n1)"
    else
        print_warning "PostgreSQL未安装，需要手动安装数据库"
        echo "Ubuntu/Debian: sudo apt install postgresql postgresql-contrib"
        echo "CentOS/RHEL: sudo yum install postgresql-server postgresql-contrib"
        echo "macOS: brew install postgresql"
    fi
    
    # 检查PM2 (可选)
    if command -v pm2 &> /dev/null; then
        print_success "PM2已安装: $(pm2 --version)"
    else
        print_warning "PM2未安装，建议安装用于进程管理"
        echo "安装命令: npm install -g pm2"
    fi
}

# 创建必要的目录
create_directories() {
    print_status "创建必要的目录结构..."
    
    mkdir -p sync-logs
    mkdir -p data-backups
    mkdir -p config
    
    print_success "目录结构创建完成"
}

# 生成配置文件模板
generate_config() {
    print_status "生成配置文件模板..."
    
    if [ ! -f ".env" ]; then
        cat << EOF > .env
# SCPPER-CN 环境配置文件
# 复制此文件为 .env 并修改相应配置

# CROM API 配置
CROM_API_URL=https://apiv1.crom.avn.sh/graphql
TARGET_SITE_URL=http://scp-wiki-cn.wikidot.com

# 数据库配置 (PostgreSQL)
DATABASE_URL=postgresql://username:password@localhost:5432/scpper_cn

# 数据库配置 (SQLite - 开发环境)
# DATABASE_URL=file:./data/scpper.db

# 同步配置
MAX_REQUESTS_PER_SECOND=1.8
BATCH_SIZE=10
ENABLE_RESUME=true

# 日志配置
LOG_LEVEL=info
LOG_DIR=./sync-logs

# 备份配置
BACKUP_DIR=./data-backups
AUTO_BACKUP=true

# 服务端口 (如果需要Web接口)
PORT=3000
HOST=0.0.0.0

# 监控配置 (可选)
ENABLE_METRICS=false
METRICS_PORT=9090
EOF
        print_success "配置文件模板已生成: .env"
        print_warning "请根据实际环境修改 .env 文件中的配置"
    else
        print_warning ".env 文件已存在，跳过生成"
    fi
}

# 数据库初始化
setup_database() {
    print_status "准备数据库初始化..."
    
    if [ -f "prisma/schema.prisma" ]; then
        print_status "检测到Prisma配置，准备数据库迁移..."
        
        # 检查.env文件中的DATABASE_URL
        if grep -q "DATABASE_URL" .env; then
            print_warning "请确保.env文件中的DATABASE_URL配置正确"
            print_warning "然后运行以下命令初始化数据库:"
            echo "  npx prisma migrate dev --name init"
            echo "  npx prisma generate"
        else
            print_error "未找到DATABASE_URL配置，请先配置数据库连接"
        fi
    else
        print_warning "未找到Prisma配置文件"
    fi
}

# 创建systemd服务文件 (Linux)
create_systemd_service() {
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        print_status "创建systemd服务文件..."
        
        SERVICE_FILE="/tmp/scpper-cn.service"
        cat << EOF > $SERVICE_FILE
[Unit]
Description=SCPPER-CN Data Sync Service
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
Environment=NODE_ENV=production
ExecStart=$(which node) src/sync/database-sync.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

# 限制资源使用
MemoryLimit=2G
CPUQuota=50%

[Install]
WantedBy=multi-user.target
EOF
        
        print_success "systemd服务文件已生成: $SERVICE_FILE"
        print_warning "手动安装服务:"
        echo "  sudo cp $SERVICE_FILE /etc/systemd/system/"
        echo "  sudo systemctl daemon-reload"
        echo "  sudo systemctl enable scpper-cn"
        echo "  sudo systemctl start scpper-cn"
    fi
}

# 创建PM2配置文件
create_pm2_config() {
    print_status "创建PM2进程配置..."
    
    cat << EOF > ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'scpper-cn-sync',
      script: 'src/sync/database-sync.js',
      cwd: './backend',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '2G',
      env: {
        NODE_ENV: 'production'
      },
      cron_restart: '0 3 * * *', // 每天凌晨3点重启
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './sync-logs/pm2-error.log',
      out_file: './sync-logs/pm2-out.log',
      log_file: './sync-logs/pm2-combined.log'
    },
    {
      name: 'scpper-cn-analysis',
      script: 'src/analysis/user-analytics.js',
      cwd: './backend',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '4G',
      env: {
        NODE_ENV: 'production'
      },
      cron_restart: '0 4 * * *' // 每天凌晨4点重启（同步后分析）
    }
  ]
};
EOF
    
    print_success "PM2配置文件已生成: ecosystem.config.js"
    print_warning "使用PM2启动服务:"
    echo "  pm2 start ecosystem.config.js"
    echo "  pm2 save"
    echo "  pm2 startup"
}

# 创建备份脚本
create_backup_script() {
    print_status "创建数据备份脚本..."
    
    cat << 'EOF' > backup.sh
#!/bin/bash

# SCPPER-CN 数据备份脚本

BACKUP_DIR="./data-backups"
DATE=$(date +%Y%m%d_%H%M%S)

echo "🗄️ 开始数据备份 - $DATE"

# 创建备份目录
mkdir -p "$BACKUP_DIR"

# 备份数据库 (如果使用PostgreSQL)
if command -v pg_dump &> /dev/null && [ -n "$DATABASE_URL" ]; then
    echo "备份PostgreSQL数据库..."
    pg_dump "$DATABASE_URL" | gzip > "$BACKUP_DIR/database_$DATE.sql.gz"
fi

# 备份配置文件
echo "备份配置文件..."
cp .env "$BACKUP_DIR/env_$DATE.backup" 2>/dev/null || true
cp ecosystem.config.js "$BACKUP_DIR/pm2_config_$DATE.backup" 2>/dev/null || true

# 备份日志文件 (最近7天)
echo "备份日志文件..."
find sync-logs -name "*.log" -mtime -7 -exec cp {} "$BACKUP_DIR/" \; 2>/dev/null || true

# 清理30天前的备份
echo "清理旧备份文件..."
find "$BACKUP_DIR" -name "*" -mtime +30 -delete 2>/dev/null || true

echo "✅ 备份完成 - $DATE"
ls -lah "$BACKUP_DIR" | tail -5
EOF
    
    chmod +x backup.sh
    print_success "数据备份脚本已生成: backup.sh"
}

# 创建监控脚本
create_monitoring_script() {
    print_status "创建服务监控脚本..."
    
    cat << 'EOF' > monitor.sh
#!/bin/bash

# SCPPER-CN 服务监控脚本

echo "🔍 SCPPER-CN 服务状态监控"
echo "=========================="

# 检查进程状态
echo "📊 进程状态:"
if command -v pm2 &> /dev/null; then
    pm2 list
else
    echo "PM2未安装，检查Node.js进程:"
    ps aux | grep -E "(database-sync|user-analytics)" | grep -v grep
fi

echo ""
echo "💾 内存使用:"
free -h

echo ""
echo "💿 磁盘使用:"
df -h .

echo ""
echo "📋 最新日志 (最近10行):"
if [ -d "sync-logs" ]; then
    find sync-logs -name "*.log" -type f -exec ls -t {} + | head -1 | xargs tail -10
else
    echo "未找到日志目录"
fi

echo ""
echo "🗄️ 数据库连接测试:"
if command -v psql &> /dev/null && [ -n "$DATABASE_URL" ]; then
    psql "$DATABASE_URL" -c "SELECT COUNT(*) as page_count FROM pages;" 2>/dev/null || echo "数据库连接失败"
else
    echo "PostgreSQL未配置或未安装"
fi

echo ""
echo "🌐 网络连接测试:"
curl -s -o /dev/null -w "CROM API: %{http_code} (%{time_total}s)\n" "https://apiv1.crom.avn.sh/graphql" || echo "CROM API连接失败"
EOF
    
    chmod +x monitor.sh
    print_success "服务监控脚本已生成: monitor.sh"
}

# 主部署流程
main() {
    echo "开始部署时间: $(date)"
    echo "部署目录: $(pwd)"
    echo "操作系统: $OSTYPE"
    echo ""
    
    check_environment
    install_system_dependencies
    install_dependencies
    create_directories
    generate_config
    setup_database
    create_pm2_config
    create_systemd_service
    create_backup_script
    create_monitoring_script
    
    echo ""
    print_success "🎉 SCPPER-CN 部署脚本执行完成!"
    echo "=================================="
    echo ""
    echo "📋 下一步操作:"
    echo "1. 修改 .env 文件中的配置参数"
    echo "2. 初始化数据库:"
    echo "   npx prisma migrate dev --name init"
    echo "   npx prisma generate"
    echo "3. 启动服务 (选择其一):"
    echo "   PM2方式: pm2 start ecosystem.config.js"
    echo "   直接运行: node src/sync/database-sync.js"
    echo "4. 验证部署:"
    echo "   ./monitor.sh"
    echo "5. 设置定时备份:"
    echo "   crontab -e 添加: 0 2 * * * cd $(pwd) && ./backup.sh"
    echo ""
    echo "📚 相关文档:"
    echo "- 部署文档: README.md"
    echo "- 脚本说明: src/sync/README.md"
    echo "- 代码整理: CROM_CODE_ORGANIZATION.md"
    echo ""
    print_warning "请仔细检查配置文件并测试各项功能后再正式使用!"
}

# 检查是否在backend目录
if [ ! -f "package.json" ]; then
    print_error "请在backend目录中运行此脚本"
    echo "使用方法: cd backend && ./deploy.sh"
    exit 1
fi

# 运行主程序
main "$@"