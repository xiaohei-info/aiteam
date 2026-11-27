import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixture } from "../test-fixture.js";
import { attachmentManifest, parseAttachmentPaths, readAttachmentRef, resolveAttachmentPath } from "./attachment-refs.js";

const owner = { conversationId: "c1", tenantId: "tenant-1", memberId: "member-1" };
const text = (result: { content: unknown[] }) => (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");

test("attachment_read pages text, notices edits, and reports moved or unreadable files", async () => {
  const fixture = await createFixture();
  const dir = mkdtempSync(join(tmpdir(), "attach-ref-"));
  try {
    const notes = join(dir, "notes.txt");
    writeFileSync(notes, "abcdefghij");
    const video = join(dir, "clip.mp4");
    writeFileSync(video, Buffer.alloc(16));
    const pages = Array.from({ length: 60 }, (_, index) => `<< /Type /Page >> (page ${index})`).join("\n");
    const pdf = join(dir, "long.pdf");
    writeFileSync(pdf, `%PDF-1.7\n${pages}\n%%EOF`, "latin1");
    const [notesRef, videoRef, pdfRef] = fixture.store.upsertLocalFileRefs(owner, [resolveAttachmentPath({ path: notes }), resolveAttachmentPath({ path: video }), resolveAttachmentPath({ path: pdf })]);
    assert(notesRef && videoRef && pdfRef);
    // The same path in one conversation keeps one ID.
    assert.equal(fixture.store.upsertLocalFileRefs(owner, [resolveAttachmentPath({ path: notes })])[0]!.id, notesRef.id);

    assert.equal(text(readAttachmentRef(fixture.store, owner, { attachment: notesRef.id, limit: 4 })).split("\n")[0], "abcd");
    assert.match(text(readAttachmentRef(fixture.store, owner, { attachment: "notes.txt", offset: 4 })), /^efghij\n\n\[已读到末尾/u);
    // More than the 50 pages an upload allows.
    assert.match(text(readAttachmentRef(fixture.store, owner, { attachment: pdfRef.id, limit: 64000 })), /page 59/u);
    assert.match(text(readAttachmentRef(fixture.store, owner, { attachment: videoRef.id })), /不支持读取内容/u);

    writeFileSync(notes, "changed!!!!!");
    utimesSync(notes, new Date(), new Date(Date.now() + 5000));
    assert.match(text(readAttachmentRef(fixture.store, owner, { attachment: notesRef.id })), /被修改过[\s\S]*changed/u);
    rmSync(notes);
    const gone = readAttachmentRef(fixture.store, owner, { attachment: notesRef.id });
    assert.equal((gone as { isError?: boolean }).isError, true);
    assert.match(text(gone), /已被移动或删除/u);
    // Another member, or a guessed ID, finds nothing.
    assert.match(text(readAttachmentRef(fixture.store, { ...owner, memberId: "member-2" }, { attachment: pdfRef.id })), /没有找到附件/u);

    const manifest = attachmentManifest([videoRef, pdfRef], new Set());
    assert.match(manifest, /clip\.mp4（视频，16 B，无法读取内容）/u);
    assert.equal(manifest.includes(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await fixture.close();
  }
});

test("attachment_paths accepts only absolute paths with plain names", () => {
  assert.deepEqual(parseAttachmentPaths(undefined), []);
  assert.deepEqual(parseAttachmentPaths([{ path: "/a/b.pdf", name: " 报告.pdf " }]), [{ path: "/a/b.pdf", name: "报告.pdf" }]);
  for (const bad of [[{ path: "b.pdf" }], [{ path: "/a", name: "x/y" }], [{ path: "/a", extra: 1 }], "nope", Array.from({ length: 9 }, () => ({ path: "/a" }))]) {
    assert.throws(() => parseAttachmentPaths(bad));
  }
});
