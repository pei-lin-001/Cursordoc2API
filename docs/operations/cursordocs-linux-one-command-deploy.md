# Cursor Docs Linux 一条命令部署

适用场景：
- Linux 考试机
- 需要后台常驻运行
- 希望测评组用一条命令直接拉起代理
- 当前题目要求与 `duck` / `zai` 并列单独命名存储

## 一条命令部署

在仓库根目录执行：

```bash
bash scripts/deploy-cursordocs-linux.sh
```

这条命令会自动完成：
1. 检查 Linux 环境
2. 检查 Node.js / npm（系统没有时会尝试本地免 root 安装 Node.js）
3. 本地安装与项目 `packageManager` 对齐的 pnpm
4. 执行 `pnpm install --frozen-lockfile`
5. 生成部署环境文件
6. 后台启动 `scripts/cursordocs-openai-compatible.ts`
7. 进行 `/health` 健康检查

## 默认运行参数

默认环境文件位置：

```bash
.cursordocs-linux/cursordocs-openai.env
```

默认监听：

```bash
CURSORDOCS_OPENAI_HOST=0.0.0.0
CURSORDOCS_OPENAI_PORT=8790
```

默认健康检查地址：

```bash
http://127.0.0.1:8790/health
```

## 常用命令

```bash
bash scripts/deploy-cursordocs-linux.sh status
bash scripts/deploy-cursordocs-linux.sh logs
bash scripts/deploy-cursordocs-linux.sh restart
bash scripts/deploy-cursordocs-linux.sh stop
bash scripts/deploy-cursordocs-linux.sh install
```

## 测评组可直接验证的接口

```bash
curl http://127.0.0.1:8790/health
curl http://127.0.0.1:8790/v1/models
```

聊天接口：

```bash
POST /v1/chat/completions
```

## 自定义部署目录

如果考试机不希望把运行文件写进仓库目录，可以指定：

```bash
CURSORDOCS_DEPLOY_APP_DIR=/opt/cursordocs-proxy bash scripts/deploy-cursordocs-linux.sh
```

## 说明

- 脚本默认面向 Linux；本地非 Linux 调试时可设置 `CURSORDOCS_DEPLOY_ALLOW_NON_LINUX=1`
- 当前上游聊天主链路是纯 HTTP，不依赖常驻浏览器，因此更适合无头服务器部署
- 当前 `/v1/models` 以已逆向确认的模型映射为默认暴露列表，后续仍可继续增强为更动态的自动发现
- 若修改了 `.cursordocs-linux/cursordocs-openai.env`，需执行 `restart` 让新配置生效
