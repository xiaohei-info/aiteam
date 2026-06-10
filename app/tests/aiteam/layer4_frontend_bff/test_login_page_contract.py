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


def _run_login_page_node(*, phone: str = "", trigger_phone_send: bool = False) -> dict:
    login_js = ROOT / "static" / "login.js"
    script = f"""
const fs = require('fs');
const vm = require('vm');
const runtime = {{
  phone: {json.dumps(phone)},
  triggerPhoneSend: {json.dumps(trigger_phone_send)},
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
    if (String(url).indexOf('/api/auth/login/wechat/init') !== -1) {{
      return Promise.resolve({{ ok: true, json: async () => ({{ state: 'wx_test', qr_url: '/mock/wechat-qr?state=wx_test', expires_in: 300 }}) }});
    }}
    if (String(url).indexOf('/api/auth/login/wechat/poll') !== -1) {{
      return Promise.resolve({{ ok: true, json: async () => ({{ status: 'pending' }}) }});
    }}
    if (String(url).indexOf('/api/auth/login/phone/send-code') !== -1) {{
      return Promise.resolve({{ ok: true, json: async () => ({{ expires_in: 300 }}) }});
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
    if (runtime.triggerPhoneSend) {{
      elements['phone-send-code'].dispatchEvent({{
        type: 'click',
        preventDefault() {{}},
      }});
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
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
    assert result["href"] == "http://localhost/login"


def test_login_page_applies_phone_send_cooldown_feedback():
    result = _run_login_page_node(phone="13800138000", trigger_phone_send=True)

    assert any("/api/auth/login/phone/send-code" in call["url"] for call in result["fetchCalls"])
    assert result["phoneSendDisabled"] is True
    assert "Resend in" in result["phoneSendText"]
    assert "resend in" in result["phoneStatus"].lower()
