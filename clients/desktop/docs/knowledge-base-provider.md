# 知识库服务适配协议

本文是**个人知识库服务**（个人 NAS 或自建服务）需实现的接口；客户端可同时连接多个实现本协议的服务，在知识库页「个人知识库」卡片点「添加个人知识库服务」连接。保存前会先调用 `GET /api/knowledge-bases` 验证连接。企业知识库（无论部署在 Manager 还是企业内网 NAS）由管理员在管理后台配置，客户端经 FredServer Manager 的 `knowledge-spaces` 接口访问，不使用本协议，也不保存企业 NAS 的地址或令牌。服务地址必须是 HTTPS，或本机回环 HTTP。令牌只通过 `Authorization: Bearer <token>` 发送。

## 读取知识库

`GET /api/knowledge-bases`

响应可以是数组，也可以是 `{ "data": [...] }` 或 `{ "data": { "items": [...] } }`。每个知识库至少包含：

```json
{
  "id": "kb-product",
  "name": "产品资料",
  "description": "产品与交付资料",
  "directory": "产品",
  "level": "team",
  "doc_count": 128,
  "updated_at": "2026-09-19T08:00:00Z",
  "updated_files_today": 4,
  "uploaded_users_today": 2,
  "files": []
}
```

`level` 字段沿用 `private`、`team`、`enterprise` 三个取值，但客户端只使用 `private`：个人服务上的知识库仅本人可见，团队级已取消，企业资料放在企业知识库。服务端没有这一约束，由客户端拦截。已有的 `team` / `enterprise` 级知识库照常读取，客户端显示「待迁移」并提示由管理员迁移到企业知识库；未返回 `level` 的知识库按服务端决定的可见范围处理，不提示迁移。`files` 中的文档需要提供 `id`、`name`、`type`、`size`、`uploadedAt`、`status` 和可选的 `chunks`。

## 写入与权限

- `POST /api/knowledge-bases`：创建知识库，正文包含 `name`、`description`、`directory`、`level`；客户端发送的 `level` 恒为 `private`。
- `POST /api/knowledge-bases/{id}/documents`：上传文档，正文包含 `name`、`mime_type`、`size`、`content_base64`。
- `POST /api/knowledge-bases/{id}/documents/{document_id}/retry`：重试失败文档。
- `PUT /api/knowledge-permissions/{employee_id}`：正文为 `{ "knowledge_base_ids": [] }`，按服务端账号岗位权限校验。
- `GET /api/knowledge-bases/{id}/search?q=...`：返回 `{ "answer": "", "citations": [], "items": [] }`。
- `GET /api/knowledge-documents/{document_id}/preview`：返回文档预览对象。

服务端应以登录账号、租户和岗位权限为最终授权来源，不能信任客户端传入的等级或员工 ID。文档入库、向量切片和权限变更应返回明确状态，避免客户端把提交成功误显示为已完成。
