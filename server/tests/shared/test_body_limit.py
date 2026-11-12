"""请求体大小上限中间件：在读请求体、跑鉴权之前按路径前缀拦截超大请求。"""

from __future__ import annotations

import pytest
from fastapi import APIRouter, Depends, FastAPI, File, Request, UploadFile
from fastapi.testclient import TestClient

from shared.body_limit import BodyLimit, BodySizeLimitMiddleware
from shared.errors import Unauthorized, install_exception_handlers
from shared.observability import RequestContextMiddleware

LIMIT = 1024


def _require_auth(request: Request) -> None:
    if request.headers.get("authorization") != "Bearer ok":
        raise Unauthorized("missing token")


def _app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(BodySizeLimitMiddleware, limits=(BodyLimit("/limited/", LIMIT),))
    app.add_middleware(RequestContextMiddleware)
    install_exception_handlers(app)
    router = APIRouter()

    @router.post("/limited/raw")
    async def raw(request: Request) -> dict[str, int]:
        return {"size": len(await request.body())}

    @router.post("/limited/upload")
    def upload(file: UploadFile = File(...), _auth: None = Depends(_require_auth)) -> dict[str, int]:
        return {"size": len(file.file.read())}

    @router.post("/open/raw")
    async def open_raw(request: Request) -> dict[str, int]:
        return {"size": len(await request.body())}

    app.include_router(router)
    return app


@pytest.fixture
def client() -> TestClient:
    return TestClient(_app())


def _assert_413(response) -> None:
    assert response.status_code == 413
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["code"] == "request_too_large" and body["status"] == 413
    assert body["request_id"] and response.headers.get("x-request-id") == body["request_id"]


def test_bodies_within_the_limit_pass_through(client):
    assert client.post("/limited/raw", content=b"x" * LIMIT).json() == {"size": LIMIT}


def test_a_declared_oversized_body_is_rejected_before_it_is_read(client):
    _assert_413(client.post("/limited/raw", content=b"x" * (LIMIT + 1)))


def test_a_chunked_oversized_body_is_cut_off_while_streaming(client):
    def chunks():
        for _ in range(4):
            yield b"x" * 512

    _assert_413(client.post("/limited/raw", content=chunks()))


def test_an_oversized_multipart_upload_gets_413_even_without_credentials(client):
    # FastAPI 先解析表单再跑鉴权依赖：没有这层拦截，未登录的请求也会被整个读完并写盘。
    response = client.post("/limited/upload", files={"file": ("a.txt", b"x" * (LIMIT * 4))})
    _assert_413(response)


def test_a_chunked_multipart_upload_is_replaced_with_413(client):
    boundary = "b0undary"
    payload = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\n"
        "Content-Type: text/plain\r\n\r\n"
    ).encode() + b"x" * (LIMIT * 4) + f"\r\n--{boundary}--\r\n".encode()

    def chunks():
        for start in range(0, len(payload), 256):
            yield payload[start:start + 256]

    response = client.post(
        "/limited/upload", content=chunks(),
        headers={"content-type": f"multipart/form-data; boundary={boundary}", "authorization": "Bearer ok"},
    )
    _assert_413(response)


def test_small_uploads_still_reach_auth_and_the_handler(client):
    files = {"file": ("a.txt", b"hello")}
    assert client.post("/limited/upload", files=files).status_code == 401
    assert client.post("/limited/upload", files=files, headers={"authorization": "Bearer ok"}).json() == {"size": 5}


def test_paths_outside_the_prefix_are_not_limited(client):
    assert client.post("/open/raw", content=b"x" * (LIMIT * 4)).json() == {"size": LIMIT * 4}
