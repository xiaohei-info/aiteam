/* Login page — external script, no inline handlers.
 * Loaded by the /login route. Reads data attributes from the form for
 * i18n strings so the server does not need to inject JS literals.
 */
document.addEventListener('DOMContentLoaded', function () {
  var form = document.getElementById('login-form');
  var input = document.getElementById('pw');
  var passkeyBtn = document.getElementById('passkey-login');
  var passwordPanel = document.getElementById('password-panel');
  var passwordToggle = document.getElementById('password-login-toggle');
  var authTabs = document.querySelectorAll('[data-auth-tab]');
  var authPanels = document.querySelectorAll('[data-auth-panel]');
  var wechatStartBtn = document.getElementById('wechat-start');
  var wechatStatus = document.getElementById('wechat-status');
  var wechatQrLink = document.getElementById('wechat-qr-link');
  var phoneInput = document.getElementById('phone');
  var phoneCodeInput = document.getElementById('phone-code');
  var phoneSendBtn = document.getElementById('phone-send-code');
  var phoneVerifyBtn = document.getElementById('phone-verify');
  var phoneStatus = document.getElementById('phone-status');
  var invalidPw = form ? (form.getAttribute('data-invalid-pw') || 'Invalid password') : 'Invalid password';
  var connFailed = form ? (form.getAttribute('data-conn-failed') || 'Connection failed') : 'Connection failed';
  var activeWechatController = null;
  var activeWechatPollTimer = null;
  var pendingWechatState = '';

  if (!form) return;

  function scopedUrl(path) {
    var rel = path.charAt(0) === '/' ? path.slice(1) : path;
    return new URL(rel, document.baseURI || window.location.href).href;
  }

  function showErr(msg) {
    var err = document.getElementById('err');
    if (err) {
      err.textContent = msg;
      err.style.display = 'block';
    }
  }

  function hideErr() {
    var err = document.getElementById('err');
    if (err) {
      err.style.display = 'none';
    }
  }

  function showPasswordPanel(open) {
    if (!passwordPanel || !passwordToggle) return;
    if (open) {
      passwordPanel.classList.add('is-open');
      passwordToggle.textContent = 'Hide password sign-in';
      if (input) input.focus();
      return;
    }
    passwordPanel.classList.remove('is-open');
    passwordToggle.textContent = 'Use password instead';
  }

  function setActiveTab(tabName) {
    for (var i = 0; i < authTabs.length; i += 1) {
      var tab = authTabs[i];
      var active = tab.getAttribute('data-auth-tab') === tabName;
      tab.classList.toggle('is-active', active);
    }
    for (var j = 0; j < authPanels.length; j += 1) {
      var panel = authPanels[j];
      var visible = panel.getAttribute('data-auth-panel') === tabName;
      panel.classList.toggle('is-active', visible);
    }
  }

  function setStatus(node, message, isError) {
    if (!node) return;
    node.textContent = message || '';
    node.style.color = isError ? '#e94560' : '#b9bfd8';
  }

  function disableWechatPolling() {
    if (activeWechatPollTimer !== null) {
      clearTimeout(activeWechatPollTimer);
      activeWechatPollTimer = null;
    }
    if (activeWechatController) {
      activeWechatController.abort();
      activeWechatController = null;
    }
  }

  function _safeNextPath() {
    try {
      var raw = new URL(window.location.href).searchParams.get('next');
      if (!raw) return './';
      if (raw.charAt(0) !== '/') return './';
      if (raw.charAt(1) === '/' || raw.charAt(1) === '\\') return './';
      if (/[\x00-\x1f\x7f\s]/.test(raw)) return './';
      return raw;
    } catch (_) {
      return './';
    }
  }

  function _defaultPostLoginPath(profile) {
    if (profile && profile.current_enterprise) return '/app/workbench';
    if (profile && profile.onboarding && profile.onboarding.action === 'create_or_join_enterprise') return '/app/workbench?onboarding=create_or_join_enterprise';
    return '/app/workbench';
  }

  async function loadProfile(accessToken) {
    var response = await fetch(scopedUrl('/api/me'), {
      method: 'GET',
      headers: accessToken ? { Authorization: 'Bearer ' + accessToken } : {},
      credentials: 'include',
    });
    var data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
      throw new Error(data.error || connFailed);
    }
    return data;
  }

  async function finishAuth(payload) {
    var profile = null;
    try {
      profile = await loadProfile(payload && payload.access_token);
    } catch (_) {}
    window.location.href = _safeNextPath() !== './' ? _safeNextPath() : _defaultPostLoginPath(profile);
  }

  async function requestJson(path, options) {
    var response = await fetch(scopedUrl(path), options);
    var data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
      throw new Error(data.error || connFailed);
    }
    return data;
  }

  async function doLogin(e) {
    e.preventDefault();
    var pw = input ? input.value : '';
    hideErr();
    try {
      var data = await requestJson('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
        credentials: 'include',
      });
      if (data.ok) {
        window.location.href = _safeNextPath();
      } else {
        showErr(data.error || invalidPw);
      }
    } catch (ex) {
      showErr(ex && ex.message ? ex.message : connFailed);
    }
  }

  form.addEventListener('submit', doLogin);

  function b64uToBytes(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64u(buf) {
    var bytes = new Uint8Array(buf);
    var bin = '';
    for (var i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  async function doPasskeyLogin() {
    if (!window.PublicKeyCredential || !navigator.credentials || !passkeyBtn) return;
    hideErr();
    try {
      passkeyBtn.disabled = true;
      var optData = await requestJson('/api/auth/passkey/options', {
        method: 'POST',
        body: '{}',
        credentials: 'include',
      });
      if (!optData.publicKey) throw new Error('Passkey unavailable');
      var pk = optData.publicKey;
      pk.challenge = b64uToBytes(pk.challenge);
      if (Array.isArray(pk.allowCredentials)) {
        pk.allowCredentials = pk.allowCredentials.map(function (c) {
          return Object.assign({}, c, { id: b64uToBytes(c.id) });
        });
      }
      var cred = await navigator.credentials.get({ publicKey: pk });
      if (!cred) throw new Error('Passkey sign-in cancelled');
      var payload = {
        id: cred.id,
        rawId: bytesToB64u(cred.rawId),
        type: cred.type,
        response: {
          authenticatorData: bytesToB64u(cred.response.authenticatorData),
          clientDataJSON: bytesToB64u(cred.response.clientDataJSON),
          signature: bytesToB64u(cred.response.signature),
          userHandle: cred.response.userHandle ? bytesToB64u(cred.response.userHandle) : null,
        },
      };
      var data = await requestJson('/api/auth/passkey/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include',
      });
      if (data.ok) window.location.href = _safeNextPath();
      else showErr(data.error || invalidPw);
    } catch (ex) {
      showErr(ex && ex.message ? ex.message : connFailed);
    } finally {
      passkeyBtn.disabled = false;
    }
  }

  async function runWechatLogin() {
    disableWechatPolling();
    hideErr();
    if (wechatStartBtn) wechatStartBtn.disabled = true;
    setStatus(wechatStatus, 'Preparing WeChat sign-in…', false);
    if (wechatQrLink) wechatQrLink.style.display = 'none';
    try {
      var initPayload = await requestJson('/api/auth/login/wechat/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        credentials: 'include',
      });
      pendingWechatState = String(initPayload.state || '');
      if (wechatQrLink && initPayload.qr_url) {
        wechatQrLink.href = scopedUrl(initPayload.qr_url);
        wechatQrLink.style.display = 'inline-flex';
      }
      setStatus(wechatStatus, 'QR ready. Waiting for scan…', false);
      activeWechatController = new AbortController();

      async function pollOnce() {
        var payload = await requestJson('/api/auth/login/wechat/poll?state=' + encodeURIComponent(pendingWechatState), {
          method: 'GET',
          credentials: 'include',
          signal: activeWechatController ? activeWechatController.signal : undefined,
        });
        if (payload.status === 'pending') {
          setStatus(wechatStatus, 'QR ready. Waiting for scan…', false);
          activeWechatPollTimer = window.setTimeout(pollOnce, 1200);
          return;
        }
        if (payload.status === 'scanned') {
          setStatus(wechatStatus, 'Scan detected. Waiting for confirmation…', false);
          activeWechatPollTimer = window.setTimeout(pollOnce, 1200);
          return;
        }
        if (payload.status === 'confirmed' && payload.code) {
          setStatus(wechatStatus, 'WeChat confirmed. Signing you in…', false);
          var callbackPayload = await requestJson('/api/auth/login/wechat/callback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: pendingWechatState, code: payload.code }),
            credentials: 'include',
          });
          await finishAuth(callbackPayload);
          return;
        }
        if (payload.status === 'expired') {
          setStatus(wechatStatus, 'QR expired. Refresh to try again.', true);
          return;
        }
        throw new Error('Unexpected WeChat status');
      }

      await pollOnce();
    } catch (ex) {
      if (!(ex && ex.name === 'AbortError')) {
        setStatus(wechatStatus, ex && ex.message ? ex.message : connFailed, true);
        showErr(ex && ex.message ? ex.message : connFailed);
      }
    } finally {
      if (wechatStartBtn) wechatStartBtn.disabled = false;
    }
  }

  async function sendPhoneCode() {
    hideErr();
    var phone = phoneInput ? String(phoneInput.value || '').trim() : '';
    if (!phone) {
      setStatus(phoneStatus, 'Phone number is required.', true);
      return;
    }
    if (phoneSendBtn) phoneSendBtn.disabled = true;
    setStatus(phoneStatus, 'Sending verification code…', false);
    try {
      await requestJson('/api/auth/login/phone/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone }),
        credentials: 'include',
      });
      setStatus(phoneStatus, 'Verification code sent. Use 888888 in test environments.', false);
      if (phoneCodeInput) phoneCodeInput.focus();
    } catch (ex) {
      setStatus(phoneStatus, ex && ex.message ? ex.message : connFailed, true);
      showErr(ex && ex.message ? ex.message : connFailed);
    } finally {
      if (phoneSendBtn) phoneSendBtn.disabled = false;
    }
  }

  async function verifyPhoneCode() {
    hideErr();
    var phone = phoneInput ? String(phoneInput.value || '').trim() : '';
    var code = phoneCodeInput ? String(phoneCodeInput.value || '').trim() : '';
    if (!phone || !code) {
      setStatus(phoneStatus, 'Phone number and verification code are required.', true);
      return;
    }
    if (phoneVerifyBtn) phoneVerifyBtn.disabled = true;
    setStatus(phoneStatus, 'Verifying code…', false);
    try {
      var payload = await requestJson('/api/auth/login/phone/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone, code: code }),
        credentials: 'include',
      });
      await finishAuth(payload);
    } catch (ex) {
      setStatus(phoneStatus, ex && ex.message ? ex.message : connFailed, true);
      showErr(ex && ex.message ? ex.message : connFailed);
    } finally {
      if (phoneVerifyBtn) phoneVerifyBtn.disabled = false;
    }
  }

  if (passkeyBtn && window.PublicKeyCredential && navigator.credentials) {
    fetch(scopedUrl('/api/auth/status'), { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { if (s && s.passkeys_enabled) passkeyBtn.style.display = 'block'; })
      .catch(function () {});
    passkeyBtn.addEventListener('click', doPasskeyLogin);
  }

  if (wechatStartBtn) wechatStartBtn.addEventListener('click', runWechatLogin);
  if (phoneSendBtn) phoneSendBtn.addEventListener('click', sendPhoneCode);
  if (phoneVerifyBtn) phoneVerifyBtn.addEventListener('click', verifyPhoneCode);
  if (passwordToggle) {
    passwordToggle.addEventListener('click', function () {
      showPasswordPanel(!passwordPanel || !passwordPanel.classList.contains('is-open'));
    });
  }

  for (var ti = 0; ti < authTabs.length; ti += 1) {
    authTabs[ti].addEventListener('click', function () {
      var tabName = this.getAttribute('data-auth-tab') || 'wechat';
      setActiveTab(tabName);
      hideErr();
    });
  }

  if (input) {
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        doLogin(e);
      }
    });
  }
  if (phoneCodeInput) {
    phoneCodeInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        verifyPhoneCode();
      }
    });
  }

  (function checkConnectivity() {
    var retryTimer = null;

    function setFormDisabled(disabled) {
      var buttons = document.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i += 1) {
        if (buttons[i].id === 'password-login-toggle') continue;
        buttons[i].disabled = disabled;
      }
      var inputs = document.querySelectorAll('input');
      for (var j = 0; j < inputs.length; j += 1) {
        inputs[j].disabled = disabled;
      }
    }

    function probe() {
      fetch(scopedUrl('health'), { method: 'GET', credentials: 'same-origin' })
        .then(function (r) {
          if (r.ok) {
            if (retryTimer !== null) {
              clearTimeout(retryTimer);
              retryTimer = null;
              window.location.reload();
            }
          } else {
            showErr(connFailed + ' (server error ' + r.status + ')');
          }
        })
        .catch(function () {
          showErr('Cannot reach server — check your VPN / Tailscale connection.');
          setFormDisabled(true);
          if (retryTimer === null) {
            retryTimer = setInterval(probe, 3000);
          }
        });
    }

    probe();
  })();

  setActiveTab('wechat');
  setStatus(wechatStatus, 'Click "Refresh QR state" to start WeChat sign-in.', false);
});
