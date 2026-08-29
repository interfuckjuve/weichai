# 启动指南

## Mock 模式

```sh
npm install
npm run dev
```

## 全后端模式

### 1. SeekDB + 检索服务

```sh
cd services/retrieval-service && docker compose up -d
npm run schema --workspace @forexplore/retrieval-service
npm run index:corpus --workspace @forexplore/retrieval-service
npm run dev:retrieval
```

### 2. 适配服务

```sh
DEEPSEEK_API_KEY="sk-xxx" \
ADAPTATION_PROJECT_ROOT="/绝对路径/fixtures/target-system/forexplore-csharp-workspace" \
ADAPTATION_ANALYSIS_ROOT="/绝对路径/目标仓库/.forexplore/analysis" \
npm run dev:adaptation
```

### 3. 前端

```sh
VITE_RETRIEVAL_API_URL="http://localhost:8787" \
VITE_ADAPTATION_API_URL="http://localhost:4001" \
npm run dev
```
