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
    return (
      '<div class="aiteam-kb-card__doc-item">' +
      '<span class="aiteam-kb-card__doc-name">' + (d.display_name || d.file_name || d.document_id || '—') + '</span>' +
      '<span class="aiteam-kb-card__doc-meta"><span class="aiteam-badge ' + badgeClass + '">' + (d.status || 'unknown') + '</span>' + chunkInfo + '</span>' +
      '</div>'
    );
  }

  function renderBindingTag(b) {
    return '<span class="aiteam-kb-card__binding-tag">' + (b.display_name || b.employee_id || '—') + '</span>';
  }

  function renderKbCard(kb) {
    var docItems = (kb.documents || []).map(renderDocumentItem).join('');
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

  function bindUploadForm() {
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
          feedback.innerHTML = '<span style="color:#4ade80">上传成功 — 文档 ID: ' + result.data.document_id + ', 状态: ' + result.data.status + '</span>';
        } else if (result) {
          feedback.innerHTML = '<span style="color:#f87171">文档登记失败: ' + (result.error || '未知错误') + '</span>';
        }
      }).catch(function () {
        feedback.innerHTML = '<span style="color:#f87171">网络请求失败</span>';
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
        var cards = kbList.map(renderKbCard).join('');
        var uploadHtml = renderUploadForm(kbList);
        var bindHtml = renderBindingForm(kbList, employees);

        container.innerHTML =
          '<div class="aiteam-shell__panel">' +
          '<p class="aiteam-shell__panel-kicker">企业前台</p>' +
          '<h2 class="aiteam-shell__panel-title">知识库</h2>' +
          '<p class="aiteam-shell__panel-body">通过 /api/team/knowledge-bases 消费企业知识库数据。</p>' +
          '<div class="aiteam-kb-grid">' + cards + '</div>' +
          uploadHtml +
          bindHtml +
          '</div>';

        bindUploadForm();
        bindEmployeeForm(kbList);
      }).catch(function () {
        ns.states.renderError(container, '知识库数据加载失败');
      });
    },
  };
}(window.aiteam));
