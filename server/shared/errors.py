"""统一错误模型实现（02 §11.2，单一事实源在 shared.contracts.Problem）。

各端入口统一用 application/problem+json；业务抛 AppError 子类，由 install_exception_handlers
转成 Problem 响应。错误体禁止含密码/token/provider key/会话内容/raw event（02 §11.2）。
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from shared.contracts.envelope import Problem, ProblemFieldError

_PROBLEM_BASE = "https://docs.aiteam.local/problems/"
_MEDIA_TYPE = "application/problem+json"


class AppError(Exception):
    """业务错误基类。status/code/title 决定 problem+json 输出。"""

    status: int = 500
    code: str = "internal_error"
    title: str = "Internal Server Error"

    def __init__(self, detail: str | None = None, *, errors: list[ProblemFieldError] | None = None):
        super().__init__(detail or self.title)
        self.detail = detail
        self.errors = errors


class Unauthorized(AppError):
    status, code, title = 401, "unauthorized", "Unauthorized"


class Forbidden(AppError):
    status, code, title = 403, "forbidden", "Forbidden"


class NotFound(AppError):
    status, code, title = 404, "not_found", "Not Found"



class InvalidTransition(AppError):
    status, code, title = 409, "invalid_transition", "Invalid lifecycle transition"


class Conflict(AppError):
    status, code, title = 409, "conflict", "Conflict"


class ValidationProblem(AppError):
    status, code, title = 422, "validation_error", "Validation error"


class TooManyRequests(AppError):
    status, code, title = 429, "rate_limited", "Too Many Requests"


def _to_problem(*, status: int, code: str, title: str, detail: str | None,
                instance: str | None, request_id: str | None,
                errors: list[ProblemFieldError] | None) -> Problem:
    return Problem(
        type=f"{_PROBLEM_BASE}{code}",
        title=title,
        status=status,
        code=code,
        detail=detail,
        instance=instance,
        request_id=request_id,
        errors=errors,
    )


def _response(problem: Problem) -> JSONResponse:
    return JSONResponse(
        status_code=problem.status,
        media_type=_MEDIA_TYPE,
        content=problem.model_dump(mode="json", exclude_none=True),
    )


def install_exception_handlers(app: FastAPI) -> None:
    """挂载统一异常处理。各端共用，不自定义错误形态（02 §11.2）。"""

    def _request_id(request: Request) -> str | None:
        return getattr(request.state, "request_id", None)

    def _instance(request: Request) -> str | None:
        # Hindsight bearer requests may put an opaque secret in the catch-all
        # path; never echo that route instance in a problem response.
        if request.url.path.startswith("/api/manager/hindsight"):
            return None
        return request.url.path

    @app.exception_handler(AppError)
    async def _handle_app_error(request: Request, exc: AppError):  # noqa: ANN202
        return _response(_to_problem(
            status=exc.status, code=exc.code, title=exc.title, detail=exc.detail,
            instance=_instance(request), request_id=_request_id(request), errors=exc.errors,
        ))

    @app.exception_handler(StarletteHTTPException)
    async def _handle_http_exception(request: Request, exc: StarletteHTTPException):  # noqa: ANN202
        code = "not_found" if exc.status_code == 404 else "http_error"
        title = "Not Found" if exc.status_code == 404 else "HTTP error"
        detail = exc.detail if isinstance(exc.detail, str) else None
        return _response(_to_problem(
            status=exc.status_code, code=code, title=title, detail=detail,
            instance=_instance(request), request_id=_request_id(request), errors=None,
        ))

    @app.exception_handler(RequestValidationError)
    async def _handle_validation(request: Request, exc: RequestValidationError):  # noqa: ANN202
        field_errors = [
            ProblemFieldError(loc=list(e.get("loc", [])), message=e.get("msg", ""), type=e.get("type", ""))
            for e in exc.errors()
        ]
        return _response(_to_problem(
            status=422, code="validation_error", title="Validation error",
            detail="Request validation failed.", instance=_instance(request),
            request_id=_request_id(request), errors=field_errors,
        ))

    @app.exception_handler(Exception)
    async def _handle_unexpected(request: Request, exc: Exception):  # noqa: ANN202
        # 详细堆栈只进受控日志，不入响应体（02 §11.2）。
        return _response(_to_problem(
            status=500, code="internal_error", title="Internal Server Error",
            detail="Unexpected server error.", instance=_instance(request),
            request_id=_request_id(request), errors=None,
        ))
