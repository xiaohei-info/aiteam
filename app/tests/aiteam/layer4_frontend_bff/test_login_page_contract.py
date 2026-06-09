from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_login_page_mentions_wechat_and_phone_auth():
    source = (ROOT / "static" / "login.js").read_text(encoding="utf-8")
    assert "/api/auth/login/wechat/init" in source
    assert "/api/auth/login/phone/send-code" in source
    assert "/api/auth/login/phone/verify" in source
