"""企业端 Manager Service（平台托管多租户企业管理 SaaS）。

职责：tenant 隔离 / 成员认证 / 专家·方案配置 / 成员级授权 / 企业 RAG / 企业治理汇总（00 §4.2.2）。
禁止：持会话与 Run/Task、提交执行、消费 runtime 原始事件、接收上传内容、向用户机器入站。
所有租户数据必须经 TenantContext/TenantRouter 访问（04 §6.1，D20/D22）。工单见 11 §4 Track M。
"""
