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

  function renderUploadForm(kbList) {
    var options = kbList.map(function (kb) {
      return '<option value="' + kb.knowledge_base_id + '">' + (kb.name || kb.knowledge_base_id) + '</option>';
    }).join('');
    return (
      '<div class="aiteam-upload-form">' +
      '<h4 class="aiteam-upload-form__title">上传文档</h4>' +
      '<div class="aiteam-upload-form__row">' +
      '<select class="aiteam-upload-form__input" id="kb-upload-select">' + options + '</select>' +
      '<input class="aiteam-upload-form__input" id="kb-upload-asset-id" placeholder="Asset ID（必填）">' +
      '<input class="aiteam-upload-form__input" id="kb-upload-display-name" placeholder="文档名称（选填）">' +
      '<button class="aiteam-upload-form__btn" id="kb-upload-submit">提交</button>' +
      '</div>' +
      '<div class="aiteam-upload-form__feedback" id="kb-upload-feedback"></div>' +
      '</div>'
    );
  }

  function bindUploadForm() {
    var btn = document.getElementById('kb-upload-submit');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var kbId = document.getElementById('kb-upload-select').value;
      var assetId = document.getElementById('kb-upload-asset-id').value.trim();
      var displayName = document.getElementById('kb-upload-display-name').value.trim();
      var feedback = document.getElementById('kb-upload-feedback');

      if (!assetId) {
        feedback.innerHTML = '<span style="color:#f87171">请输入 Asset ID</span>';
        return;
      }

      feedback.innerHTML = '提交中...';
      var body = { asset_id: assetId };
      if (displayName) body.display_name = displayName;

      ns.api.postKnowledgeDocument(kbId, body).then(function (result) {
        if (result.ok) {
          feedback.innerHTML = '<span style="color:#4ade80">上传成功 — 文档 ID: ' + result.data.document_id + ', 状态: ' + result.data.status + '</span>';
        } else {
          feedback.innerHTML = '<span style="color:#f87171">上传失败: ' + (result.error || '未知错误') + '</span>';
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

      ns.api.getKnowledgeBases().then(function (result) {
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

        var cards = kbList.map(renderKbCard).join('');
        var uploadHtml = renderUploadForm(kbList);

        container.innerHTML =
          '<div class="aiteam-shell__panel">' +
          '<p class="aiteam-shell__panel-kicker">企业前台</p>' +
          '<h2 class="aiteam-shell__panel-title">知识库</h2>' +
          '<p class="aiteam-shell__panel-body">通过 /api/team/knowledge-bases 消费企业知识库数据。</p>' +
          '<div class="aiteam-kb-grid">' + cards + '</div>' +
          uploadHtml +
          '</div>';

        bindUploadForm();
      }).catch(function () {
        ns.states.renderError(container, '知识库数据加载失败');
      });
    },
  };
}(window.aiteam));
