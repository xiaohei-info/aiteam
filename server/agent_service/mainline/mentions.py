"""@提及解析（群聊编排第一步，06 §7.6 / D19）。

群聊 = 单机多专家协作。本轮触发哪些专家，由消息文本里的 @提及决定。本模块是**纯函数**：

- :func:`parse_mentions` — Layer 1 ASCII handle（去重保序）
- :func:`resolve_mentions` — 仅 ASCII handle 路径：保序、静默忽略未知（保持 v1 既有契约）
- :func:`classify_mentions` — 路由决策唯一入口（分 ``known`` / ``ignored`` 两类）

防回环（红线）：``resolve`` / ``classify`` 都支持 ``exclude_handle``，排除发起方专家自身——
专家产出再 @自己不得形成自激循环。注意这只是解析层的一道闸；编排层（group.py）还有
"只有 USER 消息进编排"的更强约束。

双层策略（v1 相对 PR #360 / issue #414 新增的 Layer 2：让中文展示名专家也能被 @命中，
避免走 MVP「target_employee_ids 丢弃」那条丢失路由的路）：

Layer 1 — ASCII handle
    正则 ``(?<![A-Za-z0-9_@])@([A-Za-z0-9_-]+)``。守卫只挡 ASCII（[A-Za-z0-9_]）而非 ``\\w``，
    避免中文紧贴 ``@``（如「请@alice协作」）失效；同时排除 ``foo@bar.com`` 误判。

Layer 2 — 展示名 fallback（仅 Layer 1 未命中的 mention 锚点进入）
    ``@{display_name}`` 字面精确匹配 roster 内 ``display_name``（保留原样、大小写敏感）。
    锚点后紧跟的文字必须被 ASCII 分隔符结束（空白 / 英文标点 / ``$`` / 另一个 ``@``），
    避免 CJK 无空格词的交叉粘连（如「@李四和 @王五」分作 ``李四`` / ``王五``）。
"""

from __future__ import annotations

import re
import unicodedata

# Layer 1：ASCII handle。
_HANDLE_RE = re.compile(r"(?<![A-Za-z0-9_@])@([A-Za-z0-9_-]+)")

# Layer 2 分隔符：锚点后 token 读到此即结束（ASCII 控制字符始终分隔）。
_alias_delim = re.compile(r"[\s@,;:.!?()[\]{}'\"<>~`]|$|_")
_ASCII_WORD_CHAR = re.compile(r"[A-Za-z0-9_]")


def parse_mentions(text: str) -> list[str]:
    """抽出文本里的 ASCII-handle 提及，去重并保留首次出现顺序。

    这是 Layer 1。Layer 2（展示名 fallback）在 :func:`classify_mentions` 内按需补充。
    """
    seen: dict[str, None] = {}
    for m in _HANDLE_RE.finditer(text):
        seen.setdefault(m.group(1), None)
    return list(seen)


def resolve_mentions(text: str, roster: dict[str, object], *, exclude_handle: str | None = None) -> list[object]:
    """把文本里的 @提及解析为 roster 内已知专家列表（保序，ASCII handle 仅 Layer 1）。

    - 未知 handle（不在 roster）静默忽略（原有契约，保持 v1 测试 stable）。
    - ``exclude_handle``：排除该 handle（防回环——发起方专家不得 @ 触发自身）。
    """
    return [roster[h] for h in parse_mentions(text) if h in roster and h != exclude_handle]


def _is_token_char(c: str) -> bool:
    """锚点后续"合法 token 字符"判定。

    - ASCII alnum 与下划线：让 Layer 1 ASCII handle 继续读（本函数会被"紧跟 ASCII word char"短路）；
    - ASCII hyphen：display_name 允许（如 "ada-li"）但不作为 Layer 1 handle；
    - CJK 统一表意符号：允许（这是 ``display_name`` 的主体）；
    - 其它 Unicode letter（``unicodedata.category`` 以 ``L`` 开头）：允许；
    - ASCII 标点 / 中文标点 / 空白 / @ / EOF / Symbol：一律作为分隔。
    """
    if c == "_":
        return True
    if c.isascii():
        return c.isalnum() or c == "-"
    if "CJK UNIFIED IDEOGRAPH" in unicodedata.name(c, ""):
        return True
    return unicodedata.category(c).startswith("L")


def _extract_alias_candidates(text: str) -> list[str]:
    """提取 Layer 2 @{display_name} 候选（保留 @ 前缀，边界被分隔符 / 另一 @ / EOF 结束）。

    采用"prev 字符判定"：锚点必须在前一字符不是 ASCII word char / @ 时才算合法 mention
    （行首锚点 prev 为空，合法）。跳过锚点后紧跟 ASCII word char 的情况（交给 Layer 1），
    并将连续非分隔符 / 非空 token 收为一个 `@{display_name}` 候选。
    """
    out: list[str] = []
    n = len(text)
    i = 0
    while i < n:
        if text[i] != "@":
            i += 1
            continue
        prev_ch = text[i - 1] if i > 0 else ""
        if prev_ch and (_ASCII_WORD_CHAR.match(prev_ch) or prev_ch == "@"):
            i += 1
            continue
        j = i + 1
        if j < n and _ASCII_WORD_CHAR.match(text[j]):
            # ASCII handle，交给 Layer 1
            i += 1
            continue
        while j < n and _is_token_char(text[j]):
            j += 1
        token = text[i + 1:j]
        if token:
            out.append("@" + token)
        i = j
    return out


def _display_name_index(roster: dict[str, object]) -> dict[str, object]:
    """建立 display_name -> roster 实体的精确映射（大小case敏感、原样——用户 roster 里怎么写就怎么 @）。

    ``display_name`` 缺失或与普通 ASCII handle 重名则让位给 Layer 1（不允许二层 name 覆盖 handle）。
    """
    idx: dict[str, object] = {}
    for entity in roster.values():
        name = getattr(entity, "display_name", None)
        if not (isinstance(name, str) and name):
            continue
        if _ASCII_WORD_CHAR.fullmatch(name) is not None:
            # 与 Layer 1 handle 同形，免得在 "layer 1 未知 handle" 和 "layer 2 已知 alias" 之间游移
            continue
        idx[name] = entity
    return idx


def classify_mentions(
    text: str,
    roster: dict[str, object],
    *,
    exclude_handle: str | None = None,
) -> tuple[list[object], list[str]]:
    """路由决策唯一入口（06 §7.6 / D19 的 v1 落地版）：分 ``known`` / ``ignored`` 两类。

    编排层据此知道"用户 input 的 @里哪些没命中 roster"，前端给出可见错误提示
    （issue #414 验收：负向输入有清晰错误提示）。优先走 Layer 1（ASCII handle），
    Layer 1 未命中锚点走 Layer 2。

    返回 ``(known, ignored)``：

    - ``known``：roster 内命中的专家实体（保序、去重）
    - ``ignored``：未被命中的 ``@token`` 列表（保序、去重），每个都带 ``@`` 前缀
    """
    known: list[object] = []
    seen_known: set[int] = set()
    ignored: list[str] = []
    seen_ignored: set[str] = set()

    def _add_known(entity: object) -> None:
        key = id(entity)
        if key in seen_known:
            return
        seen_known.add(key)
        known.append(entity)

    def _add_ignored(token: str) -> None:
        if token in seen_ignored:
            return
        seen_ignored.add(token)
        ignored.append(token)

    # Layer 1 — ASCII handle 优先。
    for handle in parse_mentions(text):
        if handle == exclude_handle:
            continue
        entity = roster.get(handle)
        if entity is not None:
            _add_known(entity)

    # Layer 2 — 展示名fallback。
    alias_index = _display_name_index(roster)
    if alias_index:
        for raw in _extract_alias_candidates(text):
            entity = alias_index.get(raw[1:])
            if entity is not None and getattr(entity, "handle", None) != exclude_handle:
                _add_known(entity)
            else:
                _add_ignored(raw)

    return known, ignored
