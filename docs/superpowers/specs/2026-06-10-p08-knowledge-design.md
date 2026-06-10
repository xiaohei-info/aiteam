# P08 Knowledge Design

## 目标

先把 P08 从“能列知识库、能手工 POST document”推进到“页面上存在真实上传动作”，最小闭环是：

1. 用户选择知识库与文件元信息
2. 前端先调 `POST /api/team/uploads`
3. 再调 `POST /api/team/knowledge-bases/{id}/documents`
4. 页面反馈 document_id / status，并能刷新看到文档状态

## 当前事实

- 数据层与 northbound 路由已经有：knowledge base、document、ingestion job。
- 前端 [knowledge.js](/Users/chiangguantik/.codex/worktrees/a3b4/aiteam/app/static/aiteam/pages/knowledge.js) 仍要求用户手填 `Asset ID`，这不是产品上传流程。
- `/api/team/uploads` 已有 contract-shaped stub，可作为最小可演示入口。

## 本轮边界

- 不做真正 multipart 文件流。
- 不做 citation/query/bind 闭环。
- 不新增检索 API。
- 只把页面上传入口改成更真实的两段式 Team Panel 流程。

## 验证

- 新增 knowledge page layer4 测试，覆盖：
  - 页面渲染知识库卡片
  - 点击上传后先调 `/uploads` 再调 `/knowledge-bases/{id}/documents`
  - 成功后显示 document_id/status
  - 缺文件名/上传失败/文档登记失败反馈
