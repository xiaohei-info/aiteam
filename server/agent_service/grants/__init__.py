"""授权配置 sync + loaded projection + 执行快照冻结（A4，04 §6.2/§6.3，D5/D12/D14）。

用户端本地模块：周期/触发式 **主动 pull** Manager 授权配置落本地只读投影
（LoadedExpertProjection），并在装载/提交 run 时 pull 执行快照本地**冻结**留存。
Manager 离线时凭本地投影 + 已冻结快照继续工作（D14）。

红线：只主动 pull、绝不接受 Manager 推送；投影/快照写端是 Agent 本地，配置主数据单写者
仍是 Manager；本模块不改企业端配置主数据。
"""
