window.aiteam = window.aiteam || {};

(function registerKnowledgePage(ns) {
  ns.pages = ns.pages || {};

  var BADGE_MAP = {
    active: 'aiteam-badge--online',
    ready: 'aiteam-badge--ready',
    ingesting: 'aiteam-badge--ingesting',
    failed: 'aiteam-badge--failed',
    done: 'aiteam-badge--done',
  };

  function renderDocumentItem(d) {
    var badgeClass = BADGE_MAP[d.status] || 'aiteam-badge--idle';
    var chunkInfo = (d.chunk_count != null) ? ' | ' + d.chunk_count + ' chunks' : '';
    var errorHtml = d.error_message
      ? '<div class="aiteam-kb-card__doc-meta">失败原因：' + (d.error_message || '') + '</div>'
      : '';
    var retryHtml = d.status === 'error'
      ? '<button class="aiteam-upload-form__btn" type="button" data-kb-retry ' +
        'data-kb-retry-kb="' + (d.knowledge_base_id || '') + '" ' +
        'data-kb-retry-asset-id="' + (d.asset_id || '') + '" ' +
        'data-kb-retry-display-name="' + (d.display_name || '') + '" ' +
        'data-kb-retry-file-name="' + (d.file_name || '') + '" ' +
        'data-kb-retry-mime-type="' + (d.file_type || '') + '" ' +
        'data-kb-retry-size="' + String(d.file_size != null ? d.file_size : '') + '">重试入库</button>'
      : '';
    return (
      '<div class="aiteam-kb-card__doc-item">' +
      '<span class="aiteam-kb-card__doc-name">' + (d.display_name || d.file_name || d.document_id || '—') + '</span>' +
      '<span class="aiteam-kb-card__doc-meta"><span class="aiteam-badge ' + badgeClass + '">' + (d.status || 'unknown') + '</span>' + chunkInfo + '</span>' +
      errorHtml +
      retryHtml +
      '</div>'
    );
  }

  function renderBindingTag(b) {
    return '<span class="aiteam-kb-card__binding-tag">' + (b.display_name || b.employee_id || '—') + '</span>';
  }

  function renderKbCard(kb) {
    var docItems = (kb.documents || []).map(function (doc) {
      var item = Object.assign({}, doc || {});
      item.knowledge_base_id = kb.knowledge_base_id;
      return renderDocumentItem(item);
    }).join('');
    var bindings = (kb.employee_bindings || []).map(renderBindingTag).join('');
    return (
      '<div class="aiteam-kb-card">' +
      '<h3 class="aiteam-kb-card__title">' + (kb.name || '—') + '</h3>' +
      '<p class="aiteam-kb-card__desc">' + (kb.description || '') + '</p>' +
      '<div class="aiteam-kb-card__stats">' +
      '<span>状态: ' + (kb.status || 'unknown') + '</span>' +
      '<span>文档数: ' + (kb.document_count || 0) + '</span>' +
      '</div>' +
      (docItems ? '<div class="aiteam-kb-card__doc-list">' + docItems + '</div>' : '') +
      (bindings ? '<div class="aiteam-kb-card__bindings">' + bindings + '</div>' : '') +
      '</div>'
    );
  }

  function renderBindingForm(kbList, employees) {
    var kbOptions = kbList.map(function (kb) {
      return '<option value="' + kb.knowledge_base_id + '">' + (kb.name || kb.knowledge_base_id) + '</option>';
    }).join('');
    var employeeOptions = (employees || []).map(function (employee) {
      return '<option value="' + employee.employee_id + '">' + (employee.display_name || employee.employee_id) + '</option>';
    }).join('');
    return (
      '<div class="aiteam-upload-form">' +
      '<h4 class="aiteam-upload-form__title">绑定员工</h4>' +
      '<div class="aiteam-upload-form__row">' +
      '<select class="aiteam-upload-form__input" id="kb-bind-kb">' + kbOptions + '</select>' +
      '<select class="aiteam-upload-form__input" id="kb-bind-employee">' + employeeOptions + '</select>' +
      '<button class="aiteam-upload-form__btn" id="kb-bind-submit">绑定</button>' +
      '</div>' +
      '<div class="aiteam-upload-form__feedback" id="kb-bind-feedback"></div>' +
      '</div>'
    );
  }

  function renderUploadForm(kbList) {
    var options = kbList.map(function (kb) {
      return '<option value="' + kb.knowledge_base_id + '">' + (kb.name || kb.knowledge_base_id) + '</option>';
    }).join('');
    return (
      '<div class="aiteam-upload-form">' +
      '<h4 class="aiteam-upload-form__title">上传文档</h4>' +
      '<div class="aiteam-upload-form__row">' +
      '<select class="aiteam-upload-form__input" id="kb-upload-select">' + options + '</select>' +
      '<input class="aiteam-upload-form__input" id="kb-upload-file-name" placeholder="文件名（必填）">' +
      '<input class="aiteam-upload-form__input" id="kb-upload-mime-type" placeholder="MIME Type（选填）">' +
      '<input class="aiteam-upload-form__input" id="kb-upload-size" placeholder="文件大小 Bytes（选填）">' +
      '<input class="aiteam-upload-form__input" id="kb-upload-display-name" placeholder="文档名称（选填）">' +
      '<button class="aiteam-upload-form__btn" id="kb-upload-submit">提交</button>' +
      '</div>' +
      '<div class="aiteam-upload-form__feedback" id="kb-upload-feedback"></div>' +
      '</div>'
    );
  }

  function renderSearchForm(kbList) {
    var options = kbList.map(function (kb) {
      return '<option value="' + kb.knowledge_base_id + '">' + (kb.name || kb.knowledge_base_id) + '</option>';
    }).join('');
    return (
      '<div class="aiteam-upload-form">' +
      '<h4 class="aiteam-upload-form__title">知识查询</h4>' +
      '<div class="aiteam-upload-form__row">' +
      '<select class="aiteam-upload-form__input" id="kb-search-select">' + options + '</select>' +
      '<input class="aiteam-upload-form__input" id="kb-search-query" placeholder="输入查询内容">' +
      '<button class="aiteam-upload-form__btn" id="kb-search-submit">查询</button>' +
      '</div>' +
      '<div class="aiteam-upload-form__feedback" id="kb-search-feedback"></div>' +
      '<div class="aiteam-kb-card__doc-list" id="kb-search-results"></div>' +
      '</div>'
    );
  }

  function setFeedback(id, html, fallbackEl) {
    var next = document.getElementById(id);
    if (next) {
      next.innerHTML = html;
      return;
    }
    if (fallbackEl) fallbackEl.innerHTML = html;
  }

  function renderKnowledgeInto(container, kbList, employees) {
    var cards = kbList.map(renderKbCard).join('');
    var uploadHtml = renderUploadForm(kbList);
    var searchHtml = renderSearchForm(kbList);
    var bindHtml = renderBindingForm(kbList, employees);

    container.__aiteamKnowledgeKbList = kbList || [];
    container.__aiteamKnowledgeEmployees = employees || [];
    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">企业前台</p>' +
      '<h2 class="aiteam-shell__panel-title">知识库</h2>' +
      '<p class="aiteam-shell__panel-body">通过 /api/team/knowledge-bases 消费企业知识库数据。</p>' +
      '<div class="aiteam-kb-grid">' + cards + '</div>' +
      uploadHtml +
      searchHtml +
      bindHtml +
      '<div class="aiteam-upload-form__feedback" id="kb-retry-feedback"></div>' +
      '</div>';

    bindUploadForm(container);
    bindSearchForm();
    bindEmployeeForm(container.__aiteamKnowledgeKbList);
    bindRetryButtons(container);
  }

  function reloadKnowledgeBases(container) {
    if (!container || !ns.api || typeof ns.api.getKnowledgeBases !== 'function') {
      return Promise.resolve(null);
    }
    return ns.api.getKnowledgeBases().then(function (result) {
      if (!result || !result.ok || !result.data) return null;
      renderKnowledgeInto(
        container,
        (result.data.knowledge_bases || []),
        container.__aiteamKnowledgeEmployees || []
      );
      return result;
    }).catch(function () {
      return null;
    });
  }

  function bindUploadForm(container) {
    var btn = document.getElementById('kb-upload-submit');
    if (!btn || !ns.api || typeof ns.api.upload !== 'function' || typeof ns.api.postKnowledgeDocument !== 'function') return;
    btn.addEventListener('click', function () {
      var kbId = document.getElementById('kb-upload-select').value;
      var fileName = document.getElementById('kb-upload-file-name').value.trim();
      var mimeType = document.getElementById('kb-upload-mime-type').value.trim() || 'application/octet-stream';
      var sizeValue = document.getElementById('kb-upload-size').value.trim();
      var fileSize = Number(sizeValue || 0);
      var displayName = document.getElementById('kb-upload-display-name').value.trim();
      var feedback = document.getElementById('kb-upload-feedback');

      if (!fileName) {
        feedback.innerHTML = '<span style="color:#f87171">请输入文件名</span>';
        return;
      }

      feedback.innerHTML = '上传中...';
      ns.api.upload({
        name: fileName,
        mime_type: mimeType,
        size: Number.isFinite(fileSize) ? fileSize : 0,
      }).then(function (uploadResult) {
        if (!uploadResult || !uploadResult.ok || !uploadResult.data || !uploadResult.data.asset_id) {
          feedback.innerHTML = '<span style="color:#f87171">上传失败: ' + ((uploadResult && uploadResult.error) || '未知错误') + '</span>';
          return null;
        }

        feedback.innerHTML = '文档登记中...';
        var body = {
          asset_id: uploadResult.data.asset_id,
          file_name: uploadResult.data.name || fileName,
          mime_type: uploadResult.data.mime_type || mimeType,
          size: uploadResult.data.size != null ? uploadResult.data.size : (Number.isFinite(fileSize) ? fileSize : 0),
          storage_key: uploadResult.data.storage_key || '',
        };
        if (displayName) body.display_name = displayName;
        return ns.api.postKnowledgeDocument(kbId, body);
      }).then(function (result) {
        if (result === null) return;
        if (result && result.ok) {
          var successHtml = '<span style="color:#4ade80">上传成功 — 文档 ID: ' + result.data.document_id + ', 状态: ' + result.data.status + '</span>';
          return reloadKnowledgeBases(container).then(function () {
            setFeedback('kb-upload-feedback', successHtml, feedback);
          });
        } else if (result) {
          feedback.innerHTML = '<span style="color:#f87171">文档登记失败: ' + (result.error || '未知错误') + '</span>';
        }
      }).catch(function () {
        feedback.innerHTML = '<span style="color:#f87171">网络请求失败</span>';
      });
    });
  }

  function renderSearchResults(data) {
    var citations = (data.citations || []).map(function (item) {
      return '<span class="aiteam-kb-card__binding-tag">' + (item.title || item.document_id || '—') + '</span>';
    }).join('');
    var items = (data.items || []).map(function (item) {
      return (
        '<div class="aiteam-kb-card__doc-item">' +
        '<span class="aiteam-kb-card__doc-name">' + (item.title || item.document_id || '—') + '</span>' +
        '<div class="aiteam-kb-card__doc-meta">' + (item.snippet || '') + '</div>' +
        '</div>'
      );
    }).join('');
    return (
      '<div class="aiteam-kb-card">' +
      '<div class="aiteam-kb-card__doc-meta">' + (data.answer || '') + '</div>' +
      (citations ? '<div class="aiteam-kb-card__bindings">' + citations + '</div>' : '') +
      (items ? '<div class="aiteam-kb-card__doc-list">' + items + '</div>' : '') +
      '</div>'
    );
  }

  function bindSearchForm() {
    var btn = document.getElementById('kb-search-submit');
    if (!btn || !ns.api || typeof ns.api.getKnowledgeSearch !== 'function') return;
    btn.addEventListener('click', function () {
      var kbId = document.getElementById('kb-search-select').value;
      var query = document.getElementById('kb-search-query').value.trim();
      var feedback = document.getElementById('kb-search-feedback');
      var results = document.getElementById('kb-search-results');
      if (!kbId || !query) {
        feedback.innerHTML = '<span style="color:#f87171">请输入知识库和查询内容</span>';
        if (results) results.innerHTML = '';
        return;
      }

      feedback.innerHTML = '查询中...';
      if (results) results.innerHTML = '';
      ns.api.getKnowledgeSearch(kbId, query).then(function (result) {
        if (result && result.ok && result.data) {
          feedback.innerHTML = '<span style="color:#4ade80">查询成功</span>';
          if (results) results.innerHTML = renderSearchResults(result.data);
        } else {
          feedback.innerHTML = '<span style="color:#f87171">查询失败: ' + ((result && result.error) || '未知错误') + '</span>';
          if (results) results.innerHTML = '';
        }
      }).catch(function () {
        feedback.innerHTML = '<span style="color:#f87171">网络请求失败</span>';
        if (results) results.innerHTML = '';
      });
    });
  }

  function currentKnowledgeIdsForEmployee(kbList, employeeId) {
    return (kbList || []).filter(function (kb) {
      return Array.isArray(kb.employee_bindings) && kb.employee_bindings.some(function (binding) {
        return String(binding.employee_id || '') === String(employeeId || '');
      });
    }).map(function (kb) {
      return kb.knowledge_base_id;
    });
  }

  function bindEmployeeForm(kbList) {
    var btn = document.getElementById('kb-bind-submit');
    if (!btn || !ns.api || typeof ns.api.updateEmployee !== 'function') return;
    btn.addEventListener('click', function () {
      var kbId = document.getElementById('kb-bind-kb').value;
      var employeeId = document.getElementById('kb-bind-employee').value;
      var feedback = document.getElementById('kb-bind-feedback');
      if (!kbId || !employeeId) {
        feedback.innerHTML = '<span style="color:#f87171">请选择知识库和员工</span>';
        return;
      }

      var existingIds = currentKnowledgeIdsForEmployee(kbList, employeeId);
      var nextIds = existingIds.indexOf(kbId) >= 0 ? existingIds.slice() : existingIds.concat([kbId]);
      feedback.innerHTML = '绑定中...';
      ns.api.updateEmployee(employeeId, { knowledge_base_ids: nextIds }).then(function (result) {
        if (result && result.ok) {
          feedback.innerHTML = '<span style="color:#4ade80">绑定成功</span>';
        } else {
          feedback.innerHTML = '<span style="color:#f87171">绑定失败: ' + ((result && result.error) || '未知错误') + '</span>';
        }
      }).catch(function () {
        feedback.innerHTML = '<span style="color:#f87171">网络请求失败</span>';
      });
    });
  }

  function bindRetryButtons(container) {
    if (!container || !container.querySelectorAll || !ns.api || typeof ns.api.postKnowledgeDocument !== 'function') return;
    var buttons = container.querySelectorAll('[data-kb-retry]');
    for (var i = 0; i < buttons.length; i += 1) {
      var button = buttons[i];
      button.addEventListener('click', function () {
        var feedback = document.getElementById('kb-retry-feedback');
        var kbId = button.getAttribute('data-kb-retry-kb') || '';
        var assetId = button.getAttribute('data-kb-retry-asset-id') || '';
        var displayName = button.getAttribute('data-kb-retry-display-name') || '';
        var fileName = button.getAttribute('data-kb-retry-file-name') || '';
        var mimeType = button.getAttribute('data-kb-retry-mime-type') || '';
        var sizeValue = Number(button.getAttribute('data-kb-retry-size') || 0);
        if (feedback) feedback.innerHTML = '重试中...';
        ns.api.postKnowledgeDocument(kbId, {
          asset_id: assetId,
          display_name: displayName,
          file_name: fileName,
          mime_type: mimeType,
          size: Number.isFinite(sizeValue) ? sizeValue : 0,
          retry: true,
        }).then(function (result) {
          if (feedback) {
            if (result && result.ok) {
              return reloadKnowledgeBases(container).then(function () {
                setFeedback('kb-retry-feedback', '<span style="color:#4ade80">重试成功</span>', feedback);
              });
            }
            feedback.innerHTML = '<span style="color:#f87171">重试失败: ' + ((result && result.error) || '未知错误') + '</span>';
          }
        }).catch(function () {
          if (feedback) feedback.innerHTML = '<span style="color:#f87171">网络请求失败</span>';
        });
      });
    }
  }

  ns.pages.knowledge = {
    init: function (container) {
      if (!container) return;
      ns.states.renderLoading(container);

      Promise.all([
        ns.api.getKnowledgeBases(),
        ns.api.getEmployees ? ns.api.getEmployees() : Promise.resolve({ ok: true, status: 200, data: { employees: [] } }),
      ]).then(function (results) {
        var result = results[0];
        var employeeResult = results[1];
        if (!result.ok) {
          ns.states.handleApiResult(result, container, function () {});
          return;
        }

        var data = result.data;
        var kbList = (data && data.knowledge_bases) || [];

        if (!kbList.length) {
          ns.states.renderEmpty(container, '暂无知识库数据');
          return;
        }

        var employees = employeeResult && employeeResult.ok && employeeResult.data
          ? (employeeResult.data.employees || [])
          : [];
        renderKnowledgeInto(container, kbList, employees);
      }).catch(function () {
        ns.states.renderError(container, '知识库数据加载失败');
      });
    },
    __bindRetryButtons: bindRetryButtons,
  };
}(window.aiteam));
