# 生活摩擦探测器 (Life Friction Detector)

帮你发现那些已经被你习惯掉的痛点，然后给你一个今晚就能试的改变。

## 项目结构

```
├── server/                 # EdgeSpark 后端 (Hono + D1)
│   └── src/
│       ├── index.ts        # API 路由 (auth, entries, insights)
│       ├── bloome-bridge.ts # Bloome 身份桥接
│       ├── utils.ts        # 工具函数
│       └── defs/
│           ├── db_schema.ts # 数据库表定义 (Drizzle ORM)
│           └── runtime.ts   # 环境变量声明
├── widgets/                # 前端 Widget
│   ├── landing.html        # Landing Page (fake door 验证)
│   └── app.html            # 完整应用 (注册/登录/记录/洞察)
├── edgespark.toml          # EdgeSpark 项目配置
└── package.json
```

## 技术栈

- **后端**: EdgeSpark (Cloudflare Workers) + Hono + D1 (SQLite)
- **前端**: Vanilla HTML/CSS/JS Widget
- **认证**: 自建 email/password auth (SHA-256 + salt)
- **AI**: 规则引擎 (关键词匹配 + 模式分析)

## 本地开发

```bash
# 安装依赖
npm install

# 类型检查
npm run typecheck

# 生成数据库迁移
EDGESPARK_PROJECT_ENVIRONMENT=production edgespark db generate

# 应用迁移
EDGESPARK_PROJECT_ENVIRONMENT=production edgespark db migrate

# 部署
EDGESPARK_PROJECT_ENVIRONMENT=production edgespark deploy
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/public/signup` | 注册 (email + password) |
| POST | `/api/public/login` | 登录 |
| POST | `/api/public/entries` | 记录一条摩擦 |
| GET | `/api/public/entries` | 查看记录 (limit 参数) |
| GET | `/api/public/insights` | 获取 AI 洞察 |

## 数据库表

- `users` — 用户账户 (id, email, password_hash)
- `sessions` — 登录会话 (token, expires_at)
- `friction_entries` — 摩擦记录 (content, tag, created_at)
- `insights` — AI 洞察 (type, content, related_entry_ids)

## 洞察规则引擎

当记录 ≥ 3 条时自动生成：
- **频率分析**: 总数 + 日均 pace
- **模式识别**: 最常见摩擦类型及占比
- **行动建议**: 基于 top 类型的具体建议
- **连续天数**: 连续记录天数统计

## 部署

项目已部署到 EdgeSpark production:
- 后端: `https://fast-escargot-5192.youware.pro`
- Widget: 通过 Bloome 平台分发

## License

MIT
