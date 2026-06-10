from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_login_page_mentions_wechat_and_phone_auth():
    source = (ROOT / "static" / "login.js").read_text(encoding="utf-8")
    assert "/api/auth/login/wechat/init" in source
    assert "/api/auth/login/phone/send-code" in source
    assert "/api/auth/login/phone/verify" in source


def test_login_page_shell_mentions_qr_lifecycle_and_agreements():
    source = (ROOT / "api" / "routes.py").read_text(encoding="utf-8")
    assert "QR codes stay valid for 3 minutes" in source
    assert "By signing in you agree to the Service Agreement and Privacy Policy." in source
    assert "Codes expire in 5 minutes and can be resent after 60 seconds." in source
    assert "Refresh QR code" in source


def _run_login_page_node(
    *,
    phone: str = "",
    code: str = "",
    trigger_phone_send: bool = False,
    trigger_phone_verify: bool = False,
    trigger_phone_tab: bool = False,
    phone_verify_should_fail: bool = False,
    me_payload: dict | None = None,
) -> dict:
    login_js = ROOT / "static" / "login.js"
    script = f"""
const fs = require('fs');
const vm = require('vm');
const runtime = {{
  phone: {json.dumps(phone)},
  code: {json.dumps(code)},
  triggerPhoneSend: {json.dumps(trigger_phone_send)},
  triggerPhoneVerify: {json.dumps(trigger_phone_verify)},
  triggerPhoneTab: {json.dumps(trigger_phone_tab)},
  phoneVerifyShouldFail: {json.dumps(phone_verify_should_fail)},
  mePayload: {json.dumps(me_payload or {"current_enterprise": None, "onboarding": {"action": "create_or_join_enterprise"}})},
}};
const timerQueue = [];
function AbortController() {{
  this.signal = {{}};
}}
AbortController.prototype.abort = function () {{}};

function queueTimer(fn) {{
  if (typeof fn === 'function') {{
    timerQueue.push(fn);
  }}
  return timerQueue.length;
}}

async function flushRuntime(turns) {{
  for (let i = 0; i < turns; i += 1) {{
    await Promise.resolve();
    if (timerQueue.length) {{
      const next = timerQueue.shift();
      next();
    }}
  }}
}}

function createClassList() {{
  const values = new Set();
  return {{
    add(name) {{ values.add(String(name)); }},
    remove(name) {{ values.delete(String(name)); }},
    contains(name) {{ return values.has(String(name)); }},
    toggle(name, force) {{
      if (force === true) {{
        values.add(String(name));
        return true;
      }}
      if (force === false) {{
        values.delete(String(name));
        return false;
      }}
      if (values.has(String(name))) {{
        values.delete(String(name));
        return false;
      }}
      values.add(String(name));
      return true;
    }},
  }};
}}

function createElement(id) {{
  return {{
    id: id || '',
    value: '',
    disabled: false,
    textContent: '',
    href: '',
    className: '',
    style: {{}},
    attributes: {{}},
    events: {{}},
    classList: createClassList(),
    focus() {{}},
    addEventListener(type, handler) {{
      this.events[type] = this.events[type] || [];
      this.events[type].push(handler);
    }},
    dispatchEvent(event) {{
      const payload = event || {{ type: '' }};
      (this.events[payload.type] || []).forEach((handler) => handler.call(this, payload));
    }},
    setAttribute(name, value) {{
      this.attributes[name] = String(value);
    }},
    getAttribute(name) {{
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    }},
    querySelector(selector) {{
      if (selector === 'button') return null;
      return null;
    }},
  }};
}}

const elements = {{
  'login-form': createElement('login-form'),
  'pw': createElement('pw'),
  'passkey-login': createElement('passkey-login'),
  'password-panel': createElement('password-panel'),
  'password-login-toggle': createElement('password-login-toggle'),
  'wechat-start': createElement('wechat-start'),
  'wechat-status': createElement('wechat-status'),
  'wechat-qr-link': createElement('wechat-qr-link'),
  'phone': createElement('phone'),
  'phone-code': createElement('phone-code'),
  'phone-send-code': createElement('phone-send-code'),
  'phone-verify': createElement('phone-verify'),
  'phone-status': createElement('phone-status'),
  'err': createElement('err'),
}};
elements['login-form'].setAttribute('data-invalid-pw', 'Invalid password');
elements['login-form'].setAttribute('data-conn-failed', 'Connection failed');

const authTabs = [createElement('tab-wechat'), createElement('tab-phone')];
authTabs[0].setAttribute('data-auth-tab', 'wechat');
authTabs[1].setAttribute('data-auth-tab', 'phone');
const authPanels = [createElement('panel-wechat'), createElement('panel-phone')];
authPanels[0].setAttribute('data-auth-panel', 'wechat');
authPanels[1].setAttribute('data-auth-panel', 'phone');

const buttonNodes = [
  elements['wechat-start'],
  elements['phone-send-code'],
  elements['phone-verify'],
  elements['password-login-toggle'],
  elements['passkey-login'],
];
const inputNodes = [elements['pw'], elements['phone'], elements['phone-code']];
const fetchCalls = [];
const domHandlers = {{}};

const document = {{
  readyState: 'loading',
  baseURI: 'http://localhost/login',
  addEventListener(type, handler) {{
    domHandlers[type] = handler;
  }},
  getElementById(id) {{
    return elements[id] || null;
  }},
  querySelectorAll(selector) {{
    if (selector === '[data-auth-tab]') return authTabs;
    if (selector === '[data-auth-panel]') return authPanels;
    if (selector === 'button') return buttonNodes;
    if (selector === 'input') return inputNodes;
    return [];
  }},
}};

const locationState = {{
  href: 'http://localhost/login',
  search: '',
}};

const context = {{
  document,
  console,
  URL,
  window: {{
    location: locationState,
    PublicKeyCredential: null,
    AbortController,
    setTimeout(fn, _ms) {{
      return queueTimer(fn);
    }},
    clearTimeout(_id) {{}},
  }},
  AbortController,
  navigator: {{}},
  setTimeout(fn, _ms) {{
    return queueTimer(fn);
  }},
  clearTimeout(_id) {{}},
  fetch(url, options) {{
    fetchCalls.push({{ url: String(url), method: options && options.method ? options.method : 'GET' }});
    if (String(url).indexOf('health') !== -1) {{
      return Promise.resolve({{ ok: true, json: async () => ({{}}) }});
    }}
    if (String(url).indexOf('/api/auth/status') !== -1) {{
      return Promise.resolve({{ ok: true, json: async () => ({{ passkeys_enabled: false }}) }});
    }}
    if (String(url).indexOf('/api/me') !== -1) {{
      return Promise.resolve({{ ok: true, json: async () => runtime.mePayload }});
    }}
    if (String(url).indexOf('/api/auth/login/wechat/init') !== -1) {{
      return Promise.resolve({{ ok: true, json: async () => ({{ state: 'wx_test', qr_url: '/mock/wechat-qr?state=wx_test', expires_in: 300 }}) }});
    }}
    if (String(url).indexOf('/api/auth/login/wechat/poll') !== -1) {{
      return Promise.resolve({{ ok: true, json: async () => ({{ status: 'pending' }}) }});
    }}
    if (String(url).indexOf('/api/auth/login/phone/send-code') !== -1) {{
      return Promise.resolve({{ ok: true, json: async () => ({{ expires_in: 300 }}) }});
    }}
    if (String(url).indexOf('/api/auth/login/phone/verify') !== -1) {{
      if (runtime.phoneVerifyShouldFail) {{
        return Promise.resolve({{ ok: false, json: async () => ({{ error: 'Invalid phone verification code' }}) }});
      }}
      return Promise.resolve({{ ok: true, json: async () => ({{ access_token: 'at_phone_success', expires_in: 900 }}) }});
    }}
    return Promise.resolve({{ ok: true, json: async () => ({{}}) }});
  }},
}};
context.window.fetch = context.fetch;
context.window.document = document;
context.global = context;
context.globalThis = context;

vm.createContext(context);
vm.runInContext(fs.readFileSync({json.dumps(str(login_js))}, 'utf8'), context, {{ filename: 'login.js' }});

Promise.resolve()
  .then(async () => {{
    domHandlers['DOMContentLoaded']();
    await flushRuntime(24);
    if (runtime.phone) {{
      elements['phone'].value = runtime.phone;
    }}
    if (runtime.code) {{
      elements['phone-code'].value = runtime.code;
    }}
    if (runtime.triggerPhoneTab) {{
      authTabs[1].dispatchEvent({{
        type: 'click',
        preventDefault() {{}},
      }});
      await Promise.resolve();
    }}
    if (runtime.triggerPhoneSend) {{
      elements['phone-send-code'].dispatchEvent({{
        type: 'click',
        preventDefault() {{}},
      }});
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    }}
    if (runtime.triggerPhoneVerify) {{
      elements['phone-verify'].dispatchEvent({{
        type: 'click',
        preventDefault() {{}},
      }});
      await flushRuntime(24);
    }}
  }})
  .then(() => {{
    process.stdout.write(JSON.stringify({{
      fetchCalls,
      href: context.window.location.href,
      wechatStatus: elements['wechat-status'].textContent,
      wechatHref: elements['wechat-qr-link'].href,
      wechatDisplay: elements['wechat-qr-link'].style.display,
      phoneSendDisabled: elements['phone-send-code'].disabled,
      phoneSendText: elements['phone-send-code'].textContent,
      phoneStatus: elements['phone-status'].textContent,
      phonePanelActive: authPanels[1].classList.contains('is-active'),
      wechatPanelActive: authPanels[0].classList.contains('is-active'),
      errorText: elements['err'].textContent,
    }}));
  }})
  .catch((error) => {{
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }});
"""
    completed = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def test_login_page_starts_wechat_login_on_load():
    result = _run_login_page_node()

    assert any("/api/auth/login/wechat/init" in call["url"] for call in result["fetchCalls"])
    assert any("/api/auth/login/wechat/poll" in call["url"] for call in result["fetchCalls"])
    assert not any("/api/auth/login/wechat/callback" in call["url"] for call in result["fetchCalls"])
    assert result["wechatHref"].endswith("/mock/wechat-qr?state=wx_test")
    assert result["wechatDisplay"] == "inline-flex"
    assert "QR" in result["wechatStatus"] or "二维码" in result["wechatStatus"]
    assert result["wechatPanelActive"] is True
    assert result["phonePanelActive"] is False
    assert result["href"] == "http://localhost/login"


def test_login_page_applies_phone_send_cooldown_feedback():
    result = _run_login_page_node(phone="13800138000", trigger_phone_send=True, trigger_phone_tab=True)

    assert any("/api/auth/login/phone/send-code" in call["url"] for call in result["fetchCalls"])
    assert result["phonePanelActive"] is True
    assert result["phoneSendDisabled"] is True
    assert "Resend in" in result["phoneSendText"]
    assert "resend in" in result["phoneStatus"].lower()


def test_login_page_redirects_new_user_to_workbench_onboarding_hint():
    result = _run_login_page_node(
        phone="13800138000",
        code="888888",
        trigger_phone_verify=True,
        me_payload={"current_enterprise": None, "onboarding": {"action": "create_or_join_enterprise"}},
    )

    assert any("/api/auth/login/phone/verify" in call["url"] for call in result["fetchCalls"])
    assert any("/api/me" in call["url"] for call in result["fetchCalls"])
    assert result["href"] == "http://localhost/app/workbench?onboarding=create_or_join_enterprise"


def test_login_page_switches_to_phone_entry_when_phone_tab_selected():
    result = _run_login_page_node(trigger_phone_tab=True)

    assert result["phonePanelActive"] is True
    assert result["wechatPanelActive"] is False


def test_login_page_surfaces_phone_verify_failure_for_retry():
    result = _run_login_page_node(
        phone="13800138000",
        code="000000",
        trigger_phone_tab=True,
        trigger_phone_verify=True,
        phone_verify_should_fail=True,
    )

    assert any("/api/auth/login/phone/verify" in call["url"] for call in result["fetchCalls"])
    assert result["href"] == "http://localhost/login"
    assert result["phonePanelActive"] is True
    assert "invalid phone verification code" in result["phoneStatus"].lower()
    assert "invalid phone verification code" in result["errorText"].lower()
