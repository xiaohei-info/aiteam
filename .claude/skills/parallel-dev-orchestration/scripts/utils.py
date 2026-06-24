"""
工具函数模块
"""
import time
from datetime import datetime
import hashlib


def generate_run_id() -> str:
    """生成唯一的 run ID
    格式: dag-YYYYMMDD-HHMMSS-<hash>
    """
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    # 添加随机性避免同一秒内的冲突
    hash_suffix = hashlib.md5(str(time.time()).encode()).hexdigest()[:4]
    return f"dag-{timestamp}-{hash_suffix}"


def format_duration(seconds: float) -> str:
    """格式化时长为可读格式

    Examples:
        15 -> "15s"
        90 -> "1m 30s"
        3665 -> "1h 1m 5s"
    """
    if seconds < 60:
        return f"{int(seconds)}s"

    minutes = int(seconds // 60)
    remaining_seconds = int(seconds % 60)

    if minutes < 60:
        if remaining_seconds > 0:
            return f"{minutes}m {remaining_seconds}s"
        return f"{minutes}m"

    hours = minutes // 60
    remaining_minutes = minutes % 60

    parts = [f"{hours}h"]
    if remaining_minutes > 0:
        parts.append(f"{remaining_minutes}m")
    if remaining_seconds > 0:
        parts.append(f"{remaining_seconds}s")

    return " ".join(parts)


def format_timestamp(timestamp: float) -> str:
    """格式化时间戳为可读格式

    Example:
        1703419852.5 -> "2023-12-24 14:30:52"
    """
    return datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d %H:%M:%S")


def estimate_remaining_time(completed: int, total: int, elapsed: float) -> str:
    """估算剩余时间

    Args:
        completed: 已完成数量
        total: 总数量
        elapsed: 已用时间（秒）

    Returns:
        格式化的预计剩余时间，如 "38m"
    """
    if completed == 0:
        return "未知"

    remaining = total - completed
    avg_time_per_item = elapsed / completed
    estimated_seconds = remaining * avg_time_per_item

    return format_duration(estimated_seconds)


def truncate_string(s: str, max_length: int, suffix: str = "...") -> str:
    """截断字符串到指定长度

    Args:
        s: 原始字符串
        max_length: 最大长度
        suffix: 截断后缀

    Returns:
        截断后的字符串
    """
    if len(s) <= max_length:
        return s

    return s[:max_length - len(suffix)] + suffix
