"""本地能力（技能/知识/…）持久缓存 + per-run 投影（M2）。

技能真相在 Manager（capability_catalog）；本包只做：
- SkillCache：本地只读投影的持久缓存（按 skill_id + version + content_hash 判定更新）；
- SkillProjector：按 runtime 将缓存投影到 per-run workDir。

架构边界（M2）：
- 缓存只复制授权专家引用的技能包；撤销授权后由 GrantsService.sync 清理。
- 投影只写 workDir，绝不写 runtime 共享 profile（D16）。
- 运行期引用缓存版本，不依赖 Manager 在线（D14）。
"""
