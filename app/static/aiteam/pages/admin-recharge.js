window.aiteam = window.aiteam || {};

(function registerAdminRechargePage(ns) {
  ns.pages = ns.pages || {};

  var DEFAULT_RECHARGE_AMOUNT = 100;

  function formatNumber(value) {
    return Number(value || 0).toLocaleString('en-US');
  }

  function formatCurrencyYuan(value) {
    return '¥' + Number(value || 0).toFixed(2);
  }

  function formatCurrencyFromCents(value) {
    return '¥' + (Number(value || 0) / 100).toFixed(2);
  }

  function formatStatus(value) {
    if (value === 'succeeded') return '已到账';
    if (value === 'pending') return '处理中';
    if (value === 'failed') return '失败';
    return value || '-';
  }

  function getPaymentMethods(amountYuan) {
    var methods = ['mock_pay', 'wechat_pay', 'alipay'];
    if (Number(amountYuan || 0) >= 1000) {
      methods.push('bank_transfer');
    }
    return methods;
  }

  function formatPaymentMethod(method) {
    if (method === 'mock_pay') return 'mock_pay（即时测试通道）';
    if (method === 'wechat_pay') return '微信支付';
    if (method === 'alipay') return '支付宝';
    if (method === 'bank_transfer') return '银行转账';
    return method || '-';
  }

  function buildIdempotencyKey() {
    return 'admin-recharge-' + Date.now();
  }

  function normalizeUsageSummary(balance) {
    return balance && balance.usage_summary ? balance.usage_summary : { total_tokens: 0, total_cost_cents: 0 };
  }

  function normalizeRecords(items) {
    if (!Array.isArray(items)) return [];
    return items.map(function (item) {
      return {
        recharge_id: item.recharge_id,
        amount: item.amount || formatCurrencyFromCents(item.amount_cents),
        amount_cents: Number(item.amount_cents || 0),
        payment_method: item.payment_method || '-',
        status: item.status || '-',
        token_credited: Number(item.token_credited || 0),
        created_at: item.created_at || null,
        completed_at: item.completed_at || null,
      };
    });
  }

  function createState(balance, rechargeList, seed) {
    var selectedAmountYuan = Number(seed && seed.selectedAmountYuan);
    if (!Number.isFinite(selectedAmountYuan) || selectedAmountYuan < 1) {
      selectedAmountYuan = DEFAULT_RECHARGE_AMOUNT;
    }
    var selectedPaymentMethod = seed && seed.selectedPaymentMethod ? seed.selectedPaymentMethod : 'mock_pay';
    var paymentMethods = getPaymentMethods(selectedAmountYuan);
    if (paymentMethods.indexOf(selectedPaymentMethod) === -1) {
      selectedPaymentMethod = paymentMethods[0];
    }

    return {
      balance: balance || {},
      usageSummary: normalizeUsageSummary(balance),
      records: normalizeRecords(rechargeList && rechargeList.items),
      selectedAmountYuan: selectedAmountYuan,
      selectedPaymentMethod: selectedPaymentMethod,
      paymentMethods: paymentMethods,
      notice: seed && seed.notice ? seed.notice : '',
    };
  }

  function renderRecords(records) {
    if (!records.length) {
      return '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">充值记录</span><span class="aiteam-shell__meta-value">暂无充值记录；提交后会展示 /api/team/billing/recharges 返回的真实状态。</span></div>';
    }

    return (
      '<table class="aiteam-table">' +
      '<thead><tr><th>时间</th><th>方式</th><th>金额</th><th>状态</th><th>Tokens</th></tr></thead>' +
      '<tbody>' + records.map(function (record) {
        var recordTime = record.completed_at || record.created_at || '-';
        return '<tr>' +
          '<td>' + recordTime + '</td>' +
          '<td>' + formatPaymentMethod(record.payment_method) + '</td>' +
          '<td>' + (record.amount || formatCurrencyFromCents(record.amount_cents)) + '</td>' +
          '<td>' + formatStatus(record.status) + '</td>' +
          '<td>' + formatNumber(record.token_credited) + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table>'
    );
  }

  function renderRechargePage(container, state) {
    var packageButtons = [100, 500, 1000, 5000].map(function (amount) {
      var activeClass = amount === state.selectedAmountYuan ? ' is-active' : '';
      return '<button type="button" class="aiteam-pill' + activeClass + '" data-recharge-amount="' + amount + '">' + formatCurrencyYuan(amount) + '</button>';
    }).join('');

    var paymentTags = state.paymentMethods.map(function (method) {
      var activeClass = method === state.selectedPaymentMethod ? ' is-active' : '';
      return '<button type="button" class="aiteam-pill' + activeClass + '" data-recharge-method="' + method + '">' + formatPaymentMethod(method) + '</button>';
    }).join('');

    var balanceValue = state.balance && state.balance.balance ? ('¥' + state.balance.balance) : formatCurrencyFromCents(state.balance && state.balance.balance_cents);
    var banner = state.balance && state.balance.low_balance_warning
      ? '<div class="aiteam-alert aiteam-alert-warning">低余额预警：余额低于预警阈值，请尽快充值，避免对话与运行因低余额被阻断。</div>'
      : '<div class="aiteam-alert aiteam-alert-success">余额充足，企业员工运行与会话消费可继续进行。</div>';
    var notice = state.notice ? '<div class="aiteam-state aiteam-state-empty"><p>' + state.notice + '</p></div>' : '';

    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">企业后台 · B09 充值与余额</p>' +
      '<h2 class="aiteam-shell__panel-title">充值与余额</h2>' +
      '<p class="aiteam-shell__panel-body">当前页面直接消费 /api/team/billing/balance 与 /api/team/billing/recharges，并将充值动作写入 Team billing 合同。</p>' +
      banner +
      notice +
      '<div class="aiteam-billing__stats">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">当前余额</span><span class="aiteam-shell__meta-value">' + balanceValue + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">累计 Tokens</span><span class="aiteam-shell__meta-value">' + formatNumber(state.usageSummary.total_tokens) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">累计消耗</span><span class="aiteam-shell__meta-value">' + formatCurrencyFromCents(state.usageSummary.total_cost_cents) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">预估可用天数</span><span class="aiteam-shell__meta-value">' + (state.balance && state.balance.estimated_days_remaining != null ? state.balance.estimated_days_remaining : '—') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">低余额预警阈值</span><span class="aiteam-shell__meta-value">' + formatCurrencyFromCents(state.balance && state.balance.low_balance_threshold_cents) + '</span></div>' +
      '</div>' +
      '<div class="aiteam-billing__section">' +
      '<div class="aiteam-billing__section-head">发起充值</div>' +
      '<p class="aiteam-shell__panel-body aiteam-billing__subtle">充值请求会 POST 到 /api/team/billing/recharges；mock_pay 会立即到账，其余通道按后端状态展示处理中/到账结果。</p>' +
      '<div class="aiteam-billing__actions">' + packageButtons + '</div>' +
      '<div class="aiteam-billing__section-head">支付方式</div>' +
      '<div class="aiteam-billing__actions">' + paymentTags + '</div>' +
      '<div class="aiteam-billing__actions">' +
      '<input class="aiteam-input" type="number" min="1" value="' + state.selectedAmountYuan + '" data-recharge-custom-input />' +
      '<button type="button" class="aiteam-button" data-recharge-submit>提交充值</button>' +
      '<a class="aiteam-button aiteam-button--ghost" href="/admin/billing/usage">查看消耗看板</a>' +
      '</div>' +
      '</div>' +
      '<div class="aiteam-billing__section">' +
      '<div class="aiteam-billing__section-head">最近记录</div>' +
      renderRecords(state.records) +
      '</div>' +
      '</div>';
  }

  function handleError(container, result, fallbackMessage) {
    if (ns.states && ns.states.handleApiResult) {
      ns.states.handleApiResult(result, container, function () {});
    } else {
      container.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>⚠ ' + fallbackMessage + '</p></div>';
    }
  }

  function loadPageData(container, seed) {
    return Promise.all([
      ns.api.get('/api/team/billing/balance'),
      ns.api.get('/api/team/billing/recharges'),
    ]).then(function (results) {
      var balanceResult = results[0];
      var rechargeResult = results[1];
      if (!balanceResult.ok) {
        handleError(container, balanceResult, '充值页加载失败');
        return null;
      }
      if (!rechargeResult.ok) {
        handleError(container, rechargeResult, '充值记录加载失败');
        return null;
      }
      return createState(balanceResult.data || {}, rechargeResult.data || {}, seed);
    });
  }

  function bindInteractions(container, state, page) {
    if (!container || typeof container.querySelectorAll !== 'function') return;

    var amountButtons = container.querySelectorAll('[data-recharge-amount]');
    amountButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        var amount = Number(button.getAttribute('data-recharge-amount') || 0);
        state.selectedAmountYuan = amount;
        state.paymentMethods = page.getPaymentMethods(amount);
        if (state.paymentMethods.indexOf(state.selectedPaymentMethod) === -1) {
          state.selectedPaymentMethod = state.paymentMethods[0];
        }
        renderRechargePage(container, state);
        bindInteractions(container, state, page);
      });
    });

    var methodButtons = container.querySelectorAll('[data-recharge-method]');
    methodButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        state.selectedPaymentMethod = button.getAttribute('data-recharge-method') || state.selectedPaymentMethod;
        renderRechargePage(container, state);
        bindInteractions(container, state, page);
      });
    });

    var submitButton = container.querySelector('[data-recharge-submit]');
    var customInput = container.querySelector('[data-recharge-custom-input]');
    if (submitButton && customInput) {
      submitButton.addEventListener('click', function () {
        page.submitRecharge(container, state, {
          amountYuan: customInput.value,
          paymentMethod: state.selectedPaymentMethod,
        });
      });
    }
  }

  ns.pages.adminRecharge = {
    getPaymentMethods: getPaymentMethods,
    loadPageData: loadPageData,
    submitRecharge: function (container, state, payload) {
      var amountYuan = Number(payload && payload.amountYuan != null ? payload.amountYuan : state.selectedAmountYuan || 0);
      if (!Number.isFinite(amountYuan) || amountYuan < 1) {
        state.notice = '请输入不小于 1 元的充值金额';
        renderRechargePage(container, state);
        bindInteractions(container, state, ns.pages.adminRecharge);
        return Promise.resolve({ ok: false, error: 'invalid_amount' });
      }
      var paymentMethods = getPaymentMethods(amountYuan);
      var paymentMethod = payload && payload.paymentMethod ? payload.paymentMethod : state.selectedPaymentMethod;
      if (paymentMethods.indexOf(paymentMethod) === -1) {
        paymentMethod = paymentMethods[0];
      }
      var idempotencyKey = payload && payload.idempotencyKey ? payload.idempotencyKey : buildIdempotencyKey();
      var requestBody = {
        amount: amountYuan,
        payment_method: paymentMethod,
        idempotency_key: idempotencyKey,
      };

      return ns.api.post('/api/team/billing/recharges', requestBody).then(function (result) {
        if (!result.ok) {
          state.notice = '充值请求提交失败';
          renderRechargePage(container, state);
          bindInteractions(container, state, ns.pages.adminRecharge);
          return result;
        }
        return loadPageData(container, {
          selectedAmountYuan: amountYuan,
          selectedPaymentMethod: paymentMethod,
          notice: paymentMethod === 'mock_pay' ? '充值已提交并已按后端返回刷新余额与记录' : '充值已提交，等待后端通道完成到账',
        }).then(function (nextState) {
          if (!nextState) return result;
          Object.assign(state, nextState);
          renderRechargePage(container, state);
          bindInteractions(container, state, ns.pages.adminRecharge);
          return result;
        });
      });
    },
    init: function (container) {
      if (!container) return;

      container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载充值与余额...</p></div>';

      loadPageData(container, {}).then(function (state) {
        if (!state) return;
        renderRechargePage(container, state);
        container.lastSubmitHandler = function (payload) {
          return ns.pages.adminRecharge.submitRecharge(container, state, payload || {});
        };
        bindInteractions(container, state, ns.pages.adminRecharge);
      });
    },
  };
}(window.aiteam));
