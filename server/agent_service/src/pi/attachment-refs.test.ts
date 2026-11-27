import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixture } from "../test-fixture.js";
import { attachmentManifest, parseAttachmentPaths, readAttachmentRef, resolveAttachmentPath } from "./attachment-refs.js";
import { projectPathPolicyForTests } from "./project-path-policy.js";

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

// The path arrives from the renderer, so the Agent refuses credential folders itself. Library/AppData stay
// attachable: screenshots and app caches live there and the client lets the user attach those.
test("attachment paths inside a credential folder are refused, other folders are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-cred-"));
  try {
    mkdirSync(join(dir, ".ssh"));
    const key = join(dir, ".ssh", "id_rsa");
    writeFileSync(key, "PRIVATE");
    assert.throws(() => resolveAttachmentPath({ path: key }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "attachment_in_credential_folder");
      assert.match((error as Error).message, /凭据[\s\S]*\.ssh/u);
      return true;
    });

    mkdirSync(join(dir, "Library", "Caches"), { recursive: true });
    const shot = join(dir, "Library", "Caches", "shot.png");
    writeFileSync(shot, Buffer.alloc(4));
    assert.equal(resolveAttachmentPath({ path: shot }).name, "shot.png");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// One source of truth: the credential list is the subset of the project-folder policy that applies here.
test("credential_home_roots is the credential subset of home_roots", () => {
  const policy = projectPathPolicyForTests();
  for (const platform of [policy.macos, policy.windows]) {
    assert(platform.credential_home_roots && platform.credential_home_roots.length > 0);
    for (const root of platform.credential_home_roots) assert(platform.home_roots.includes(root), root);
  }
  assert.equal(policy.macos.credential_home_roots!.includes("Library"), false);
  assert.equal(policy.windows.credential_home_roots!.includes("AppData"), false);
});
