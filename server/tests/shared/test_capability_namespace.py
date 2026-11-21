"""Rule table of design 2026-11-20「技能MCP命名空间出处与更新提示」§4.1."""

from shared.capability_namespace import (
    PLATFORM_NAMESPACE,
    as_edited,
    clawhub_provenance,
    namespace_for,
    normalize_provenance,
    origin_provenance,
    platform_provenance,
    qualified_label,
    url_provenance,
)


def test_our_own_content_takes_our_namespace():
    assert namespace_for(PLATFORM_NAMESPACE, None) == "taiyim"
    assert namespace_for("太一科技", None) == "太一科技"


def test_unchanged_content_from_another_platform_has_no_namespace_and_cites_it():
    hub = clawhub_provenance("steipete", "weather", version="1.0.0")
    assert hub == {"kind": "clawhub", "label": "ClawHub steipete/weather", "url": "https://clawhub.ai/steipete/skills/weather", "version": "1.0.0", "edited": False}
    assert namespace_for(PLATFORM_NAMESPACE, hub) == ""
    gh = url_provenance("https://github.com/acme/skills/tree/main/notes")
    assert gh["label"] == "github.com/acme/skills" and namespace_for("acme", gh) == ""


def test_edited_content_takes_our_namespace_and_keeps_the_first_upstream_version():
    edited = as_edited(clawhub_provenance("steipete", "weather", version="1.0.0"), version="2.0.0")
    assert edited["edited"] is True and edited["version"] == "1.0.0"
    assert namespace_for(PLATFORM_NAMESPACE, edited) == "taiyim"
    assert as_edited(None) is None
    copy = platform_provenance("taiyim/weather", version="8c2d")
    assert copy["edited"] is True and namespace_for("太一科技", copy) == "太一科技"


def test_labels_and_legacy_origin():
    assert qualified_label("taiyim", "weather") == "taiyim/weather" and qualified_label("", "weather") == "weather"
    assert origin_provenance({"kind": "clawhub", "label": "ClawHub", "url": "https://clawhub.ai/pskoett/skills/self-improving-agent"})["label"] == "ClawHub pskoett/self-improving-agent"
    assert origin_provenance({"kind": "url", "label": "x", "url": "https://github.com/a/b"})["label"] == "github.com/a/b"
    assert origin_provenance({"kind": "folder", "label": "文件夹"}) is None


def test_untrusted_shapes_are_dropped_and_links_must_be_https():
    assert normalize_provenance({"kind": "ftp", "label": "x"}) is None
    assert normalize_provenance({"kind": "url", "label": ""}) is None
    assert normalize_provenance({"kind": "url", "label": "x", "url": "javascript:alert(1)"})["url"] == ""
