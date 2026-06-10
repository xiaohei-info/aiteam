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


def _run_login_page_node() -> dict:
    login_js = ROOT / "static" / "login.js"
    script = f"""
const fs = require('fs');
const vm = require('vm');

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
    setTimeout(fn, _ms) {{
      return 1;
    }},
    clearTimeout(_id) {{}},
  }},
  navigator: {{}},
  setTimeout(fn, _ms) {{
    return 1;
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
  .then(() => domHandlers['DOMContentLoaded']())
  .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
  .then(() => {{
    process.stdout.write(JSON.stringify({{
      fetchCalls,
      href: context.window.location.href,
      wechatStatus: elements['wechat-status'].textContent,
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


def test_login_page_does_not_start_wechat_login_on_load():
    result = _run_login_page_node()

    assert not any("/api/auth/login/wechat/init" in call["url"] for call in result["fetchCalls"])
    assert not any("/api/auth/login/wechat/poll" in call["url"] for call in result["fetchCalls"])
    assert not any("/api/auth/login/wechat/callback" in call["url"] for call in result["fetchCalls"])
    assert result["href"] == "http://localhost/login"



def _run_password_login(fetch_responses: list[dict], location_href: str = "http://localhost/login") -> dict:
    login_js = ROOT / "static" / "login.js"
    script = """
const fs = require('fs');
const vm = require('vm');

function createClassList() {
  const values = new Set();
  return {
    add(name) { values.add(String(name)); },
    remove(name) { values.delete(String(name)); },
    contains(name) { return values.has(String(name)); },
    toggle(name, force) {
      if (force === true) {
        values.add(String(name));
        return true;
      }
      if (force === false) {
        values.delete(String(name));
        return false;
      }
      if (values.has(String(name))) {
        values.delete(String(name));
        return false;
      }
      values.add(String(name));
      return true;
    },
  };
}

function createElement(id) {
  return {
    id: id || '',
    value: '',
    disabled: false,
    textContent: '',
    href: '',
    className: '',
    style: {},
    attributes: {},
    events: {},
    classList: createClassList(),
    focus() {},
    addEventListener(type, handler) {
      this.events[type] = this.events[type] || [];
      this.events[type].push(handler);
    },
    dispatchEvent(event) {
      const payload = event || { type: '' };
      (this.events[payload.type] || []).forEach((handler) => handler.call(this, payload));
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
    querySelector() {
      return null;
    },
  };
}

const elements = {
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
};
elements['login-form'].setAttribute('data-invalid-pw', 'Invalid password');
elements['login-form'].setAttribute('data-conn-failed', 'Connection failed');
elements['pw'].value = 'secret';

const authTabs = [createElement('tab-wechat'), createElement('tab-phone')];
authTabs[0].setAttribute('data-auth-tab', 'wechat');
authTabs[1].setAttribute('data-auth-tab', 'phone');
const authPanels = [createElement('panel-wechat'), createElement('panel-phone')];
authPanels[0].setAttribute('data-auth-panel', 'wechat');
authPanels[1].setAttribute('data-auth-panel', 'phone');

const responseQueue = __FETCH_RESPONSES__;
const fetchCalls = [];
const domHandlers = {};

const document = {
  readyState: 'loading',
  baseURI: __LOCATION_HREF__,
  addEventListener(type, handler) {
    domHandlers[type] = handler;
  },
  getElementById(id) {
    return elements[id] || null;
  },
  querySelectorAll(selector) {
    if (selector === '[data-auth-tab]') return authTabs;
    if (selector === '[data-auth-panel]') return authPanels;
    return [];
  },
};

const locationState = {
  href: __LOCATION_HREF__,
  search: new URL(__LOCATION_HREF__).search,
};

const context = {
  document,
  console,
  URL,
  window: {
    location: locationState,
    PublicKeyCredential: null,
    setTimeout(fn, _ms) {
      return 1;
    },
    clearTimeout(_id) {},
  },
  navigator: {},
  setTimeout(fn, _ms) {
    return 1;
  },
  clearTimeout(_id) {},
  fetch(url, options) {
    fetchCalls.push({ url: String(url), method: options && options.method ? options.method : 'GET' });
    if (String(url).indexOf('health') !== -1) {
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }
    if (String(url).indexOf('/api/auth/status') !== -1) {
      return Promise.resolve({ ok: true, json: async () => ({ passkeys_enabled: false }) });
    }
    const next = responseQueue.shift();
    if (!next) {
      throw new Error('Unexpected fetch: ' + String(url));
    }
    return Promise.resolve({
      ok: next.ok,
      json: async () => next.body,
    });
  },
};
context.window.fetch = context.fetch;
context.window.document = document;
context.global = context;
context.globalThis = context;

vm.createContext(context);
vm.runInContext(fs.readFileSync(__LOGIN_JS_PATH__, 'utf8'), context, { filename: 'login.js' });

Promise.resolve()
  .then(() => domHandlers['DOMContentLoaded']())
  .then(() => elements['login-form'].dispatchEvent({
    type: 'submit',
    preventDefault() {},
  }))
  .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
  .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
  .then(() => {
    process.stdout.write(JSON.stringify({
      fetchCalls,
      href: context.window.location.href,
      error: elements['err'].textContent,
    }));
  })
  .catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
"""
    script = script.replace("__FETCH_RESPONSES__", json.dumps(fetch_responses))
    script = script.replace("__LOCATION_HREF__", json.dumps(location_href))
    script = script.replace("__LOGIN_JS_PATH__", json.dumps(str(login_js)))
    completed = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def test_password_login_redirects_create_or_join_enterprise_profiles_to_onboarding_workbench() -> None:
    result = _run_password_login(
        [
            {"ok": True, "body": {"ok": True, "access_token": "tok_123"}},
            {
                "ok": True,
                "body": {
                    "current_enterprise": None,
                    "onboarding": {"action": "create_or_join_enterprise"},
                },
            },
        ]
    )

    assert result["fetchCalls"][-2:] == [
        {"url": "http://localhost/api/auth/login", "method": "POST"},
        {"url": "http://localhost/api/me", "method": "GET"},
    ]
    assert result["href"] == "/app/workbench?onboarding=create_or_join_enterprise"
    assert result["error"] == ""
